// Outbound mail via the anfani.com Stalwart submission relay (msmtp-style settings).
// Configure through env (see .env.example). In dev with no SMTP_HOST set, links are
// logged to the console instead of sent, so you can copy/paste them.
import nodemailer from "nodemailer";

const HOST = process.env.SMTP_HOST || "";
const PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const USER = process.env.SMTP_USER || "";
const PASS = process.env.SMTP_PASS || "";
const FROM = process.env.MAIL_FROM || "A Scow Tuner <atuner@anfani.com>";
const STARTTLS = (process.env.SMTP_STARTTLS || "true") === "true";

let transport = null;
if (HOST) {
  transport = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: PORT === 465,            // implicit TLS on 465, STARTTLS otherwise
    requireTLS: STARTTLS && PORT !== 465,
    auth: USER ? { user: USER, pass: PASS } : undefined
  });
}

async function send(to, subject, text, html) {
  if (!transport) {
    console.log(`\n[mail:dev] To: ${to}\n[mail:dev] Subject: ${subject}\n${text}\n`);
    return;
  }
  await transport.sendMail({ from: FROM, to, subject, text, html });
}

export function sendLoginLink(to, url) {
  const text = `Sign in to A Scow Tuner:\n\n${url}\n\nThis link is single-use and expires soon. If you didn't request it, ignore this email.`;
  const html = `<p>Sign in to <strong>A Scow Tuner</strong>:</p><p><a href="${url}">${url}</a></p>` +
    `<p style="color:#667">This link is single-use and expires soon. If you didn't request it, ignore this email.</p>`;
  return send(to, "Sign in to A Scow Tuner", text, html);
}

export function sendAppInvite(to, url, inviterEmail) {
  const subject = "You're invited to A Scow Tuner";
  const text = `${inviterEmail} invited you to use A Scow Tuner, a rig tuning log for A Scows.\n\n` +
    `Sign in to get started (you can create your own boats):\n${url}\n\n` +
    `This link is single-use and expires in 7 days. After that you can request a new one from the sign-in page.`;
  const html = `<p><strong>${inviterEmail}</strong> invited you to use <strong>A Scow Tuner</strong>, ` +
    `a rig tuning log for A Scows.</p><p><a href="${url}">Sign in to get started</a> — you can create your own boats.</p>` +
    `<p style="color:#667">This link is single-use and expires in 7 days. After that you can request a new one from the sign-in page.</p>`;
  return send(to, subject, text, html);
}

export function sendInvite(to, url, boatName, inviterEmail) {
  const subject = `You're invited to tune "${boatName}"`;
  const text = `${inviterEmail} invited you to help tune the boat "${boatName}" on A Scow Tuner.\n\n` +
    `Accept and sign in:\n${url}\n\nThis link is single-use and expires soon.`;
  const html = `<p><strong>${inviterEmail}</strong> invited you to help tune the boat ` +
    `"<strong>${boatName}</strong>" on A Scow Tuner.</p><p><a href="${url}">Accept &amp; sign in</a></p>` +
    `<p style="color:#667">This link is single-use and expires soon.</p>`;
  return send(to, subject, text, html);
}
