// SQLite storage for users, sessions, magic-link tokens, boats, memberships, invites.
// One file on a Docker volume. Synchronous (better-sqlite3) — fine at this scale.
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const DB_PATH = process.env.DB_PATH || "/data/atuner.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  created_at  INTEGER NOT NULL,
  last_login  INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- single-use magic links for login AND invite acceptance
CREATE TABLE IF NOT EXISTS magic_tokens (
  token       TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  purpose     TEXT NOT NULL,          -- 'login' | 'invite'
  boat_id     TEXT,                   -- invite: boat being shared
  role        TEXT,                   -- invite: 'editor' | 'owner'
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

CREATE TABLE IF NOT EXISTS boats (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  data        TEXT NOT NULL,          -- JSON: { config, log }
  rev         INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS boat_members (
  boat_id     TEXT NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,          -- 'owner' | 'editor'
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (boat_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  token        TEXT PRIMARY KEY,      -- == magic_tokens.token
  boat_id      TEXT NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL,
  invited_by   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  accepted_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email) WHERE accepted_at IS NULL;
`);

export const now = () => Date.now();
export const newId = () => randomBytes(12).toString("hex");
export const newToken = () => randomBytes(32).toString("base64url");
export const normalizeEmail = (e) => String(e || "").trim().toLowerCase();

export function getUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email));
}

export function getOrCreateUser(email) {
  email = normalizeEmail(email);
  let u = getUserByEmail(email);
  if (!u) {
    const id = newId();
    db.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(id, email, now());
    u = getUserByEmail(email);
  }
  return u;
}

export function hasPendingInvite(email) {
  return !!db.prepare(
    "SELECT 1 FROM invites WHERE email = ? AND accepted_at IS NULL AND expires_at > ? LIMIT 1"
  ).get(normalizeEmail(email), now());
}

// --- sessions ---
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days

export function createSession(userId) {
  const token = newToken();
  const t = now();
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(token, userId, t, t + SESSION_TTL);
  return token;
}

export function getSessionUser(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`
  ).get(token, now());
  return row || null;
}

export function destroySession(token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

// --- boats / membership ---
export function membership(boatId, userId) {
  return db.prepare("SELECT * FROM boat_members WHERE boat_id = ? AND user_id = ?").get(boatId, userId);
}

export function listBoatsForUser(userId) {
  return db.prepare(
    `SELECT b.id, b.name, b.rev, b.updated_at, m.role
     FROM boats b JOIN boat_members m ON m.boat_id = b.id
     WHERE m.user_id = ? ORDER BY b.name COLLATE NOCASE`
  ).all(userId);
}
