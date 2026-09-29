import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { ukDate } from './complaintRules.js';

// ---------------------------------------------------------------------------
// Email reminders via SMTP2GO (https://www.smtp2go.com/).
// Uses standard SMTP; credentials come from the SMTP_* env vars.
// If not configured, sending is a no-op so the rest of the app keeps working.
// ---------------------------------------------------------------------------

let transporter = null;

function getTransport() {
  if (!config.smtp.enabled) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
  }
  return transporter;
}

export function mailerStatus() {
  return {
    enabled: config.smtp.enabled,
    host: config.smtp.host,
    port: config.smtp.port,
    to: config.smtp.to,
  };
}

export async function sendReminderEmail({ subject, html, text, to }) {
  const transport = getTransport();
  const recipients = to || config.smtp.to;
  if (!transport || recipients.length === 0) {
    return { sent: false, reason: 'SMTP2GO not configured' };
  }
  await transport.sendMail({
    from: config.smtp.from,
    to: recipients.join(', '),
    subject,
    text,
    html,
  });
  return { sent: true, to: recipients };
}

// The addresses copied in on every email to someone outside Greenco
// (utilities@ by default), left out when already a recipient.
export function withExternalCc(to, cc) {
  const have = new Set([...(to || []), ...(cc || [])].map((a) => String(a).trim().toLowerCase()));
  return [...(cc || []), ...config.smtp.externalCc.filter((a) => !have.has(a.toLowerCase()))];
}

// Send an email to someone outside Greenco (complaint correspondence,
// commission invoices). Greenco's own copy address is always copied in (see
// config.smtp.externalCc). Throws if SMTP2GO isn't configured so the caller
// can surface it.
export async function sendMail({ to, cc, subject, text, html, replyTo, attachments }) {
  const transport = getTransport();
  if (!transport) {
    throw new HttpError(503, 'Email sending isn’t configured — set SMTP_USER / SMTP_PASS.');
  }
  const toList = Array.isArray(to) ? to : String(to || '').split(',').map((a) => a.trim()).filter(Boolean);
  const ccList = Array.isArray(cc) ? cc : String(cc || '').split(',').map((a) => a.trim()).filter(Boolean);
  cc = withExternalCc(toList, ccList);
  const info = await transport.sendMail({
    from: config.smtp.from,
    to: Array.isArray(to) ? to.join(', ') : to,
    cc: cc && cc.length ? (Array.isArray(cc) ? cc.join(', ') : cc) : undefined,
    replyTo,
    subject,
    text,
    html,
    ...(attachments?.length ? { attachments } : {}),
  });
  return { sent: true, messageId: info.messageId };
}

// The address complaint mail is sent from (so we can log it as the sender).
export function fromAddress() {
  return config.smtp.from;
}

// Send a password-reset link. Returns { sent } — never throws to the caller so
// a mail hiccup can't reveal whether an address exists.
export async function sendPasswordResetEmail({ to, link }) {
  const transport = getTransport();
  if (!transport) return { sent: false, reason: 'SMTP2GO not configured' };
  await transport.sendMail({
    from: config.smtp.from,
    to,
    subject: 'Reset your Greenco Accounts CRM password',
    text:
      `Someone requested a password reset for your Greenco Accounts CRM account.\n\n` +
      `Reset it here (valid for 1 hour):\n${link}\n\n` +
      `If you didn't request this, you can ignore this email.`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#1e2235;">
        <h2 style="color:#1e2235;">Reset your password</h2>
        <p>Someone requested a password reset for your Greenco Accounts CRM account.</p>
        <p><a href="${link}" style="display:inline-block;background:#a2c533;color:#1e2235;
          font-weight:600;padding:11px 20px;border-radius:8px;text-decoration:none;">
          Reset password</a></p>
        <p style="color:#6b7280;font-size:13px;">This link is valid for 1 hour. If you
          didn't request it, you can ignore this email.</p>
      </div>`,
  });
  return { sent: true };
}

// Invite a new member of the team: they follow the link and set their own
// password, so one is never typed into the admin screen or passed along.
// Returns { sent } rather than throwing — losing the account over a mail hiccup
// would be worse than telling the administrator to send it again.
export async function sendInviteEmail({ to, name, link, invitedBy }) {
  const transport = getTransport();
  if (!transport) return { sent: false, reason: 'SMTP2GO not configured' };
  const who = invitedBy ? ` by ${invitedBy}` : '';
  await transport.sendMail({
    from: config.smtp.from,
    to,
    subject: 'Your Greenco Accounts CRM account',
    text:
      `Hello${name ? ` ${name}` : ''},\n\n` +
      `You have been added${who} to the Greenco Accounts CRM.\n\n` +
      `Set your password here (the link is valid for 7 days):\n${link}\n\n` +
      `Once you have, sign in at ${config.appUrl}.`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#1e2235;">
        <h2 style="color:#1e2235;">You've been added to the Accounts CRM</h2>
        <p>Hello${name ? ` ${escapeText(name)}` : ''}, you have been added${escapeText(who)}
           to the Greenco Accounts CRM.</p>
        <p><a href="${link}" style="display:inline-block;background:#a2c533;color:#1e2235;
          font-weight:600;padding:11px 20px;border-radius:8px;text-decoration:none;">
          Set your password</a></p>
        <p style="color:#6b7280;font-size:13px;">This link is valid for 7 days. Afterwards you can
          sign in at <a href="${config.appUrl}">${config.appUrl}</a>.</p>
      </div>`,
  });
  return { sent: true };
}

// Names come from a form, and this is HTML.
function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Item text can come from outside (a complaint subject read off an email), so
// it is escaped before it goes into the HTML.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[ch]);
const safeLink = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : null);

// The morning reminder email: what is overdue first, then what is coming up.
// Each item is one block (date, what, whose, the next step and a link) rather
// than table columns, because it is mostly read on a phone. An item may carry
// `detail` (what to do) and `link` (where to do it).
export function buildDigest(items) {
  if (items.length === 0) {
    return {
      subject: 'Greenco Accounts: nothing due',
      text: 'No key dates, tasks or complaint deadlines are due or overdue right now.',
      html: '<p>No key dates, tasks or complaint deadlines are due or overdue right now.</p>',
    };
  }
  const overdue = items.filter((i) => i.overdue);
  const coming = items.filter((i) => !i.overdue);

  const textOf = (list) => list
    .map((i) => `- ${ukDate(i.due_date)}  ${i.label}${i.company_name ? ` (${i.company_name})` : ''}` +
      `${i.detail ? `\n    Next: ${i.detail}` : ''}${safeLink(i.link) ? `\n    ${i.link}` : ''}`)
    .join('\n');
  const htmlOf = (list, colour) => list
    .map((i) => `
      <div style="padding:10px 0;border-bottom:1px solid #e5e7eb;">
        <div style="font-size:13px;font-weight:600;color:${colour};">${esc(ukDate(i.due_date))}</div>
        <div style="margin-top:2px;">${
          safeLink(i.link) ? `<a href="${esc(i.link)}" style="color:#1e2235;">${esc(i.label)}</a>` : esc(i.label)
        }${i.company_name ? `<span style="color:#6b7280;"> · ${esc(i.company_name)}</span>` : ''}</div>${
          i.detail ? `<div style="color:#6b7280;font-size:13px;margin-top:2px;">Next: ${esc(i.detail)}</div>` : ''
        }
      </div>`)
    .join('');
  const heading = (t, colour) =>
    `<h3 style="margin:20px 0 4px;font-size:15px;color:${colour};border-bottom:2px solid #a2c533;padding-bottom:4px;">${t}</h3>`;

  const counts = [
    overdue.length ? `${overdue.length} overdue` : null,
    coming.length ? `${coming.length} coming up` : null,
  ].filter(Boolean).join(', ');
  return {
    subject: `Greenco Accounts: ${counts}`,
    text: [
      overdue.length ? `OVERDUE (${overdue.length})\n\n${textOf(overdue)}` : null,
      coming.length ? `COMING UP (${coming.length})\n\n${textOf(coming)}` : null,
    ].filter(Boolean).join('\n\n'),
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#1e2235;max-width:640px;">
        <h2 style="color:#1e2235;margin-bottom:0;">Greenco Accounts reminders</h2>
        ${overdue.length ? heading(`Overdue (${overdue.length})`, '#b91c1c') + htmlOf(overdue, '#b91c1c') : ''}
        ${coming.length ? heading(`Coming up (${coming.length})`, '#1e2235') + htmlOf(coming, '#1e2235') : ''}
      </div>`,
  };
}
