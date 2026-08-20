import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Storage for uploaded contractor invoices (the PDF/photo of the invoice that
// carried the commission). Kept separate from complaint attachments because
// these are financial records: one document per logged invoice, and the whole
// point is being able to produce it later when the contractor queries a claim.
//
// Files land in <uploadDir>/contractor-invoices/<random uuid>/<safe name>. The
// directory is a fresh UUID per upload rather than anything derived from user
// input, so there is no path to traverse and no ordering dependency on when
// multer happens to parse the body fields.
// ---------------------------------------------------------------------------

const UPLOAD_ROOT = path.resolve(config.uploadDir, 'contractor-invoices');
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB — comfortably more than a scanned invoice

await fs.mkdir(UPLOAD_ROOT, { recursive: true }).catch(() => {});

function safeName(originalname) {
  return (originalname || 'invoice').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
}

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    const dir = path.join(UPLOAD_ROOT, globalThis.crypto.randomUUID());
    try {
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (_req, file, cb) => cb(null, safeName(file.originalname)),
});

// One document per invoice — a second file would have nowhere to be recorded.
export const invoiceUpload = multer({ storage, limits: { fileSize: MAX_BYTES, files: 1 } });

// The extractor never needs the file on disk: it reads it, returns fields, and
// the user re-submits the file with the form if they save. Keeping it in memory
// means a cancelled upload leaves nothing behind to clean up.
export const invoiceMemoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

export function documentStream(storagePath) {
  return createReadStream(storagePath);
}

// Remove a stored document (and its now-empty directory). Best-effort: a
// missing file must not stop the row being deleted.
export async function removeDocument(storagePath) {
  if (!storagePath) return;
  const resolved = path.resolve(storagePath);
  if (!resolved.startsWith(`${UPLOAD_ROOT}${path.sep}`)) return; // never unlink outside our root
  await fs.unlink(resolved).catch(() => {});
  await fs.rmdir(path.dirname(resolved)).catch(() => {});
}
