import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';

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

// Send an arbitrary email (used to send complaint correspondence from the app).
// Throws if SMTP2GO isn't configured so the caller can surface it.
export async function sendMail({ to, cc, subject, text, html, replyTo }) {
  const transport = getTransport();
  if (!transport) {
    throw new HttpError(503, 'Email sending isn’t configured — set SMTP_USER / SMTP_PASS.');
  }
  const info = await transport.sendMail({
    from: config.smtp.from,
    to: Array.isArray(to) ? to.join(', ') : to,
    cc: cc && cc.length ? (Array.isArray(cc) ? cc.join(', ') : cc) : undefined,
    replyTo,
    subject,
    text,
    html,
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

// Build a simple digest email body from a list of due/overdue items.
export function buildDigest(items) {
  if (items.length === 0) {
    return {
      subject: 'Greenco Accounts — nothing due',
      text: 'No key dates or tasks are due or overdue right now.',
      html: '<p>No key dates or tasks are due or overdue right now.</p>',
    };
  }

  const rows = items
    .map(
      (i) =>
        `- ${i.due_date}  ${i.label}${i.company_name ? ` (${i.company_name})` : ''}${
          i.overdue ? '  [OVERDUE]' : ''
        }`,
    )
    .join('\n');

  const htmlRows = items
    .map(
      (i) => `
      <tr>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;white-space:nowrap;color:${
          i.overdue ? '#b91c1c' : '#1e2235'
        };font-weight:600;">${i.due_date}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;">${i.label}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;">${
          i.company_name || ''
        }</td>
      </tr>`,
    )
    .join('');

  return {
    subject: `Greenco Accounts — ${items.length} item(s) due soon`,
    text: `Upcoming and overdue items:\n\n${rows}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#1e2235;">
        <h2 style="color:#1e2235;">Greenco Accounts — reminders</h2>
        <table style="border-collapse:collapse;width:100%;max-width:640px;">
          <thead>
            <tr>
              <th style="text-align:left;padding:6px 12px;border-bottom:2px solid #a2c533;">Due</th>
              <th style="text-align:left;padding:6px 12px;border-bottom:2px solid #a2c533;">Item</th>
              <th style="text-align:left;padding:6px 12px;border-bottom:2px solid #a2c533;">Company</th>
            </tr>
          </thead>
          <tbody>${htmlRows}</tbody>
        </table>
      </div>`,
  };
}
