// Small helpers shared across route modules.
import { z } from 'zod';

// Wrap an async route handler so thrown errors reach the Express error handler.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Every primary-key column in this app is a UUID (gen_random_uuid()), but a
// route handler that queries `WHERE id = $1` before checking that shape trips
// Postgres's own "invalid input syntax for type uuid" — an unhandled 500,
// logged with a full stack trace, for what is really just a bad URL (a typo,
// a stale link, or — as found in testing — a route ordering surprise like
// GET /export.csv falling through to GET /:id because /export.csv wasn't
// registered as its own path). Wire this into a router with
// `router.param('id', requireUuidParam)` once, and it's enforced for every
// route on that router using `:id`, however many there are.
export function requireUuidParam(req, _res, next, value) {
  if (!z.string().uuid().safeParse(value).success) {
    return next(new HttpError(400, `Invalid id`));
  }
  next();
}

// A tagged error carrying an HTTP status code.
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Validate a request body/params against a zod schema, throwing 400 on failure.
export const parse = (schema, data) => {
  const result = schema.safeParse(data);
  if (!result.success) {
    // Say which field and why ("Mobile: Give a phone number…"), not just
    // "Validation failed": the page shows this message as it stands.
    const flat = result.error.flatten();
    const [field, msgs] = Object.entries(flat.fieldErrors || {}).find(([, m]) => m?.length) || [];
    const label = field ? field.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : null;
    const message = field ? `${label}: ${msgs[0]}` : flat.formErrors?.[0] || 'Validation failed';
    throw new HttpError(400, message, flat);
  }
  return result.data;
};

// Content-Disposition for a download, safe for any file name. A header can
// only carry Latin-1, so a name with "’" or "–" (Outlook puts them in
// attachment names) made the download fail; the plain filename is an ASCII
// copy and filename* carries the real name (RFC 6266 / 5987).
export function attachmentDisposition(name, fallback = 'download', { inline = false } = {}) {
  const real = String(name || '').replace(/[\r\n"\\]/g, '').trim() || fallback;
  const ascii = real.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '').replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(real).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// The file types a browser may show in its own tab (to look at a document
// before it goes with an email): a PDF or a photo, nothing that can run
// script. The type sent is chosen from this list, never the stored one as
// typed, and nosniff stops the browser second-guessing it, so an HTML file
// uploaded as "application/pdf" is shown as a broken PDF, never run.
// Anything else (Word, text, HTML, SVG) is a download. Null: download it.
const VIEWABLE = new Map([
  ['application/pdf', 'application/pdf'], ['image/png', 'image/png'], ['image/jpeg', 'image/jpeg'],
  ['image/jpg', 'image/jpeg'], ['image/gif', 'image/gif'], ['image/webp', 'image/webp'],
]);
export function viewableType(mimetype) {
  return VIEWABLE.get(String(mimetype || '').toLowerCase().split(';')[0].trim()) || null;
}

// A date as the forms send it (YYYY-MM-DD, a real day). Anything else is
// refused rather than handed to Postgres, which reads "12/01/2026" as 1 Dec.
const realDay = (v) => {
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
export const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-30').refine(realDay, 'Not a real date');
// The same, for a date that may be left blank: '' and null both clear it.
// A phone number as people write one: figures, spaces, + ( ) - . and an
// extension ("0161 850 8687", "+44 (0)161 850 8687 ext 12"). Blank clears it.
export const phoneLine = z.string().max(120)
  .refine((v) => !v.trim() || (/^\+?[0-9()\-.\s]+(?:\s*(?:ext\.?|extension|x)\s*\d{1,6})?$/i.test(v.trim()) && (v.match(/\d/g) || []).length >= 6),
    'Give a phone number (figures, spaces, + and brackets only).')
  .optional().nullable();
export const optionalIsoDate = z.union([isoDate, z.literal('').transform(() => null)]).optional().nullable();
