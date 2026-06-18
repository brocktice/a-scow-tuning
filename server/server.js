// A Scow Tuner — self-hosted server.
// Serves the static front end + a JSON API with magic-link auth (invite-only),
// shared boats, and emailed invites. SQLite storage (server/db.js), SMTP (server/mail.js).
import express from "express";
import { parse as parseCookie } from "cookie";
import { resolve } from "node:path";
import {
  db, now, newId, newToken, normalizeEmail,
  getUserByEmail, getOrCreateUser, hasPendingInvite,
  createSession, getSessionUser, destroySession,
  membership, listBoatsForUser
} from "./db.js";
import { sendLoginLink, sendInvite, sendAppInvite } from "./mail.js";

const PORT = parseInt(process.env.PORT || "8790", 10);
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const STATIC_DIR = resolve(process.env.STATIC_DIR || "./public");
const COOKIE = "atuner_session";
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === "true"
  : APP_BASE_URL.startsWith("https://");

const LOGIN_TTL = 1000 * 60 * 30;          // 30 min
const INVITE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days
// always-eligible bootstrap accounts (first owner / admins), comma-separated
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
);

const app = express();
app.use(express.json({ limit: "4mb" }));

// ---------- helpers ----------
function setSessionCookie(res, token) {
  const parts = [
    `${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax",
    `Max-Age=${60 * 60 * 24 * 30}`
  ];
  if (COOKIE_SECURE) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}
function clearSessionCookie(res) {
  const parts = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (COOKIE_SECURE) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}
function currentUser(req) {
  const token = parseCookie(req.headers.cookie || "")[COOKIE];
  return getSessionUser(token);
}
function requireUser(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "auth required" });
  req.user = u;
  next();
}
function requireMember(req, res, next) {
  const m = membership(req.params.id, req.user.id);
  if (!m) return res.status(404).json({ error: "not found" });
  req.member = m;
  next();
}
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// auto-accept any pending invites for a (just-authenticated) user
function acceptPendingInvites(user) {
  const invs = db.prepare(
    "SELECT * FROM invites WHERE email = ? AND accepted_at IS NULL AND expires_at > ?"
  ).all(user.email, now());
  const addMember = db.prepare(
    "INSERT OR IGNORE INTO boat_members (boat_id, user_id, role, created_at) VALUES (?, ?, ?, ?)"
  );
  const markAccepted = db.prepare("UPDATE invites SET accepted_at = ? WHERE token = ?");
  const t = now();
  for (const inv of invs) {
    addMember.run(inv.boat_id, user.id, inv.role, t);
    markAccepted.run(t, inv.token);
  }
}

// ---------- auth ----------
app.post("/api/auth/request", (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isEmail(email)) return res.status(400).json({ error: "invalid email" });
  // invite-only: only existing users, pending invitees, or bootstrap admins get a link
  if (getUserByEmail(email) || hasPendingInvite(email) || ADMIN_EMAILS.has(email)) {
    const token = newToken();
    const t = now();
    db.prepare(
      "INSERT INTO magic_tokens (token, email, purpose, created_at, expires_at) VALUES (?, ?, 'login', ?, ?)"
    ).run(token, email, t, t + LOGIN_TTL);
    sendLoginLink(email, `${APP_BASE_URL}/api/auth/callback?token=${token}`)
      .catch((e) => console.error("mail error", e));
  }
  // always generic, to avoid leaking who has an account
  res.json({ ok: true });
});

app.get("/api/auth/callback", (req, res) => {
  const token = String(req.query.token || "");
  const row = db.prepare("SELECT * FROM magic_tokens WHERE token = ?").get(token);
  if (!row || row.used_at || row.expires_at < now()) {
    return res.status(400).send("This sign-in link is invalid or expired. Request a new one.");
  }
  db.prepare("UPDATE magic_tokens SET used_at = ? WHERE token = ?").run(now(), token);
  const user = getOrCreateUser(row.email);
  acceptPendingInvites(user);
  db.prepare("UPDATE users SET last_login = ? WHERE id = ?").run(now(), user.id);
  setSessionCookie(res, createSession(user.id));
  const dest = row.purpose === "invite" && row.boat_id ? `/?boat=${row.boat_id}` : "/";
  res.redirect(dest);
});

app.post("/api/auth/logout", (req, res) => {
  const token = parseCookie(req.headers.cookie || "")[COOKIE];
  destroySession(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "auth required" });
  res.json({ email: u.email, id: u.id, admin: ADMIN_EMAILS.has(u.email) });
});

// admin-only: invite someone to use the app standalone (their own boats, no boat shared)
app.post("/api/admin/invite", requireUser, (req, res) => {
  if (!ADMIN_EMAILS.has(req.user.email)) return res.status(403).json({ error: "admins only" });
  const email = normalizeEmail(req.body?.email);
  if (!isEmail(email)) return res.status(400).json({ error: "invalid email" });
  // create the account so they can also self-serve a login link later, then email a welcome link
  getOrCreateUser(email);
  const token = newToken();
  const t = now();
  db.prepare(
    "INSERT INTO magic_tokens (token, email, purpose, created_at, expires_at) VALUES (?, ?, 'login', ?, ?)"
  ).run(token, email, t, t + INVITE_TTL);
  sendAppInvite(email, `${APP_BASE_URL}/api/auth/callback?token=${token}`, req.user.email)
    .catch((e) => console.error("mail error", e));
  res.json({ ok: true });
});

// ---------- boats ----------
app.get("/api/boats", requireUser, (req, res) => {
  res.json({ boats: listBoatsForUser(req.user.id) });
});

app.post("/api/boats", requireUser, (req, res) => {
  const name = String(req.body?.name || "").trim() || "New boat";
  const data = req.body?.data ?? { config: null, log: [] };
  const id = newId();
  const t = now();
  db.prepare("INSERT INTO boats (id, name, data, rev, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)")
    .run(id, name, JSON.stringify(data), t, t);
  db.prepare("INSERT INTO boat_members (boat_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
    .run(id, req.user.id, t);
  res.json({ id, name, rev: 1, role: "owner" });
});

app.get("/api/boats/:id", requireUser, requireMember, (req, res) => {
  const b = db.prepare("SELECT id, name, data, rev FROM boats WHERE id = ?").get(req.params.id);
  res.json({ id: b.id, name: b.name, rev: b.rev, role: req.member.role, data: JSON.parse(b.data) });
});

app.put("/api/boats/:id", requireUser, requireMember, (req, res) => {
  if (req.member.role === "viewer") return res.status(403).json({ error: "view only" });
  const b = db.prepare("SELECT rev FROM boats WHERE id = ?").get(req.params.id);
  const baseRev = req.body?.rev;
  if (baseRev != null && baseRev !== b.rev) {
    const cur = db.prepare("SELECT id, name, data, rev FROM boats WHERE id = ?").get(req.params.id);
    return res.status(409).json({ error: "conflict", rev: cur.rev, data: JSON.parse(cur.data), name: cur.name });
  }
  const fields = [], vals = [];
  if (req.body?.data !== undefined) { fields.push("data = ?"); vals.push(JSON.stringify(req.body.data)); }
  if (req.body?.name !== undefined) { fields.push("name = ?"); vals.push(String(req.body.name).trim() || "Boat"); }
  const rev = b.rev + 1;
  fields.push("rev = ?"); vals.push(rev);
  fields.push("updated_at = ?"); vals.push(now());
  vals.push(req.params.id);
  db.prepare(`UPDATE boats SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  res.json({ rev });
});

app.delete("/api/boats/:id", requireUser, requireMember, (req, res) => {
  if (req.member.role !== "owner") return res.status(403).json({ error: "owner only" });
  db.prepare("DELETE FROM boats WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- sharing ----------
app.get("/api/boats/:id/members", requireUser, requireMember, (req, res) => {
  const members = db.prepare(
    `SELECT u.email, m.role FROM boat_members m JOIN users u ON u.id = m.user_id
     WHERE m.boat_id = ? ORDER BY m.role, u.email`
  ).all(req.params.id);
  const invites = db.prepare(
    "SELECT token, email, role FROM invites WHERE boat_id = ? AND accepted_at IS NULL AND expires_at > ?"
  ).all(req.params.id, now());
  res.json({ members, invites, you: req.user.email, role: req.member.role });
});

app.post("/api/boats/:id/invites", requireUser, requireMember, (req, res) => {
  if (req.member.role !== "owner") return res.status(403).json({ error: "owner only" });
  const email = normalizeEmail(req.body?.email);
  const role = ["owner", "editor", "viewer"].includes(req.body?.role) ? req.body.role : "editor";
  if (!isEmail(email)) return res.status(400).json({ error: "invalid email" });
  const existing = db.prepare(
    `SELECT 1 FROM boat_members m JOIN users u ON u.id = m.user_id WHERE m.boat_id = ? AND u.email = ?`
  ).get(req.params.id, email);
  if (existing) return res.status(409).json({ error: "already a member" });

  const boat = db.prepare("SELECT name FROM boats WHERE id = ?").get(req.params.id);
  const token = newToken();
  const t = now();
  db.prepare(
    "INSERT INTO magic_tokens (token, email, purpose, boat_id, role, created_at, expires_at) VALUES (?, ?, 'invite', ?, ?, ?, ?)"
  ).run(token, email, req.params.id, role, t, t + INVITE_TTL);
  db.prepare(
    "INSERT INTO invites (token, boat_id, email, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(token, req.params.id, email, role, req.user.id, t, t + INVITE_TTL);
  sendInvite(email, `${APP_BASE_URL}/api/auth/callback?token=${token}`, boat.name, req.user.email)
    .catch((e) => console.error("mail error", e));
  res.json({ ok: true, email, role });
});

app.delete("/api/boats/:id/invites/:token", requireUser, requireMember, (req, res) => {
  if (req.member.role !== "owner") return res.status(403).json({ error: "owner only" });
  db.prepare("DELETE FROM invites WHERE boat_id = ? AND token = ?").run(req.params.id, req.params.token);
  db.prepare("DELETE FROM magic_tokens WHERE token = ? AND used_at IS NULL").run(req.params.token);
  res.json({ ok: true });
});

app.delete("/api/boats/:id/members/:userEmail", requireUser, requireMember, (req, res) => {
  if (req.member.role !== "owner") return res.status(403).json({ error: "owner only" });
  const target = getUserByEmail(req.params.userEmail);
  if (!target) return res.status(404).json({ error: "not found" });
  const owners = db.prepare("SELECT COUNT(*) c FROM boat_members WHERE boat_id = ? AND role = 'owner'")
    .get(req.params.id).c;
  const tm = membership(req.params.id, target.id);
  if (tm?.role === "owner" && owners <= 1) return res.status(400).json({ error: "can't remove the last owner" });
  db.prepare("DELETE FROM boat_members WHERE boat_id = ? AND user_id = ?").run(req.params.id, target.id);
  res.json({ ok: true });
});

// ---------- health + static ----------
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use(express.static(STATIC_DIR, { extensions: ["html"] }));

app.listen(PORT, () => {
  console.log(`atuner listening on :${PORT}  base=${APP_BASE_URL}  static=${STATIC_DIR}`);
});
