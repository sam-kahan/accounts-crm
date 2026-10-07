// The full Greenco email signature, for every email the CRM sends to
// someone outside (complaint emails, commission invoices), signed by the
// person who sent it: their name and letters, job title and numbers, then
// the Trustpilot badge, the offices banner, the social links and the
// confidentiality notice, as on Greenco's own Outlook signature.
//
// Pure: the sender's details in, { text, html } out. The pictures go in the
// email itself (`cid:` images, `signatureImages()`), not linked from a
// server, so they show without the reader choosing to "download pictures".
// A preview in the browser asks for them by URL instead (`imageSrc`).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../assets/signature');

export const DISCLAIMER =
  'Confidentiality: This email message and any attachments are for the sole use of the intended recipient(s) and may ' +
  'contain proprietary, confidential, trade-secret, legal or privileged information. Any unauthorised review, use, ' +
  'disclosure or distribution is prohibited and may be a violation of law. If you are not the intended recipient, please ' +
  'contact the sender by reply email and destroy all copies of the original message. Security: Email is not a secure ' +
  'means of communication. Viruses: You should carry out your own virus check before opening any attachment to ' +
  'this email. To the extent permitted by law, we do not accept liability for any virus infection and/or external ' +
  'compromise of security in relation to email transmissions';

// The social icons, in the order the signature shows them. Each shows only
// with its link set (config.signature.links): an icon going nowhere, or to a
// guessed page, is worse than none.
export const SOCIAL = ['twitter', 'facebook', 'linkedin', 'rightmove', 'zoopla'];
const SOCIAL_LABEL = { twitter: 'X (Twitter)', facebook: 'Facebook', linkedin: 'LinkedIn', rightmove: 'Rightmove', zoopla: 'Zoopla' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const FONT = "font-family:Calibri,Aptos,Arial,Helvetica,sans-serif;font-size:11pt;color:#000000;";

// The lines of the sender's details, as written: "Sam Kahan MAAT",
// "Finance Director", then each number they have set.
export function senderLines(user = {}) {
  const name = [clean(user.name) || clean(user.email), clean(user.post_nominals)].filter(Boolean).join(' ');
  const contact = [
    ['Direct Line', clean(user.direct_line)],
    ['Mobile', clean(user.mobile)],
    ['Office', clean(user.office_phone)],
    ['Email', clean(user.email)],
  ].filter(([, v]) => v);
  return { name, title: clean(user.job_title), contact };
}

// { text, html } of the signature. `closing`: start with "Kind regards,".
// `imageSrc(name)`: where each picture is (cid: in an email, a URL in a
// preview). `links`: { website, trustpilot, twitter, … } (config.signature).
export function buildSignature(user, { closing = true, imageSrc = (n) => `cid:sig-${n}@greenco`, links = {} } = {}) {
  const { name, title, contact } = senderLines(user);
  const text = [
    ...(closing ? ['Kind regards,', ''] : []),
    name,
    ...(title ? [title] : []),
    ...(contact.length ? ['', ...contact.map(([k, v]) => `${k} ${v}`)] : []),
    '',
    DISCLAIMER,
  ].join('\n');

  const link = (href, inner) => (href ? `<a href="${esc(href)}" style="text-decoration:none;">${inner}</a>` : inner);
  const contactHtml = contact.map(([k, v]) => {
    const value = k === 'Email'
      ? `<a href="mailto:${esc(v)}" style="color:#0563c1;">${esc(v)}</a>`
      : `<a href="tel:${esc(v.replace(/[^\d+]/g, ''))}" style="color:#000000;text-decoration:none;">${esc(v)}</a>`;
    return `${esc(k)} ${value}`;
  }).join('<br>');
  const icons = SOCIAL.filter((s) => links[s]).map((s) =>
    link(links[s], `<img src="${imageSrc(s)}" width="32" height="32" alt="${esc(SOCIAL_LABEL[s])}" style="border:0;display:inline-block;margin-right:6px;">`));
  const html = `
<div style="${FONT}">
  ${closing ? '<p style="margin:0 0 14px;">Kind regards,</p>' : ''}
  <p style="margin:0 0 14px;">${esc(name)}${title ? `<br>${esc(title)}` : ''}</p>
  ${contactHtml ? `<p style="margin:0 0 14px;">${contactHtml}</p>` : ''}
  <p style="margin:0 0 10px;">${link(links.trustpilot, `<img src="${imageSrc('trustpilot')}" width="258" height="20" alt="Excellent on Trustpilot" style="border:0;display:block;">`)}</p>
  <p style="margin:0 0 10px;">${link(links.website, `<img src="${imageSrc('banner')}" width="501" height="171" alt="Greenco Property Group: Greater Manchester 0161 708 8629, Liverpool 0151 523 6600, greenco.co.uk" style="border:0;display:block;max-width:100%;height:auto;">`)}</p>
  ${icons.length ? `<p style="margin:0 0 10px;">${icons.join('')}</p>` : ''}
  <p style="margin:0;font-size:10pt;color:#000000;">${esc(DISCLAIMER)}</p>
</div>`.trim();
  return { text, html };
}

// The pictures an email with this signature carries, as nodemailer
// attachments (inline, by cid). Only the ones the signature uses.
export function signatureImages(links = {}) {
  const names = ['trustpilot', 'banner', ...SOCIAL.filter((s) => links[s])];
  return names.map((n) => {
    const file = n === 'banner' ? 'banner.jpg' : `${n}.png`;
    return { filename: file, path: path.join(ASSETS, file), cid: `sig-${n}@greenco`, contentDisposition: 'inline' };
  });
}
export const signatureAssetPath = (file) => (/^[a-z]+\.(png|jpg)$/.test(file) ? path.join(ASSETS, file) : null);

const CLOSING = /^[ \t]*(?:kind regards|best regards|warm regards|regards|best wishes|many thanks|thanks|thank you|yours sincerely|yours faithfully),?[ \t]*$/i;

// The email without its short sign-off, so the full signature replaces it:
// the last closing line ("Kind regards,") and ONLY what a sign-off is after
// it: a name, a job title, "Greenco", a [Name]/[Job title] placeholder.
// Anything else there (a sentence, a P.S., a quoted email) means it isn't
// the sign-off, or more follows it: nothing is removed (`kept`), and the
// signature goes under it without a second closing. An "Attached: …" line
// (withAttachedLine) is kept in the body, never removed with the sign-off.
const ATTACHED = /^\s*Attached:/i;
const SIGN_LINE = (l) => {
  const t = l.trim();
  if (!t) return true;
  if (/^\[[^\]]{1,30}\]$/.test(t)) return true; // [Name], [Job title]
  if (t.length > 60 || t.split(/\s+/).length > 7) return false;
  if (/[.?!:;]$/.test(t) && !/\b(?:ltd|plc|co)\.$/i.test(t)) return false;
  if (/^(?:p\.?s\b|-{2,}|_{2,}|>|from\b|sent\b|to\b|subject\b|on\s.+wrote)/i.test(t)) return false;
  return true;
};
export function withoutSignOff(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!CLOSING.test(lines[i])) continue;
    // A closing with nothing before it is the message itself ("Many thanks
    // for your reply" as an email's first words), not a sign-off.
    const before = lines.slice(0, i).join('\n').trim();
    const tail = lines.slice(i + 1);
    const attached = tail.filter((l) => ATTACHED.test(l));
    const rest = tail.filter((l) => !ATTACHED.test(l));
    if (before && rest.every(SIGN_LINE)) {
      const head = [before, ...attached.map((l) => l.trim())].join('\n\n');
      return { head, closing: lines[i].trim().replace(/,?$/, ','), kept: false };
    }
    return { head: lines.join('\n'), closing: null, kept: true };
  }
  return { head: lines.join('\n'), closing: null, kept: false };
}

// The body as plain text paragraphs in HTML.
export function bodyHtml(text) {
  return String(text ?? '').split(/\n{2,}/).filter((p) => p.trim())
    .map((p) => `<p style="margin:0 0 14px;">${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

// An email signed in full: { text, html, attachments } to give sendMail.
// The person's own closing word is kept ("Many thanks," stays); none means
// "Kind regards,". No sender (an email queued before this): unchanged.
export function signedEmail(body, user, { links = {} } = {}) {
  if (!user) return { text: body, html: undefined, attachments: [] };
  const { head, closing, kept } = withoutSignOff(body);
  const sig = buildSignature(user, { closing: false, links });
  // Their own closing word, or "Kind regards," — none added under a closing
  // that had to stay (a P.S. after it).
  const close = closing || (kept ? null : 'Kind regards,');
  const text = [head, ...(close ? [close] : []), sig.text].join('\n\n');
  const html = `<div style="${FONT}">\n${bodyHtml(head)}\n${close ? `<p style="margin:0 0 14px;">${esc(close)}</p>` : ''}\n</div>\n${sig.html}`;
  return { text, html, attachments: signatureImages(links) };
}
