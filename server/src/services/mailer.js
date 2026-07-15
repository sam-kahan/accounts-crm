import nodemailer from 'nodemailer';
import { config } from '../config.js';

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
