import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { query } from '../db/pool.js';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Evidence attachments for complaints. Files are streamed to disk under
// config.uploadDir/<complaintId>/ and tracked in complaint_attachments. Plain
// text is extracted (best-effort) so the AI assistant can read the contents.
// ---------------------------------------------------------------------------

const UPLOAD_ROOT = path.resolve(config.uploadDir);
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB / file

await fs.mkdir(UPLOAD_ROOT, { recursive: true }).catch(() => {});

const storage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    const dir = path.join(UPLOAD_ROOT, req.params.id);
    // Belt-and-braces against path traversal: never write outside the upload
    // root even if an un-validated id slips through (the route guards this too).
    const rel = path.relative(UPLOAD_ROOT, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return cb(new Error('Invalid upload path'));
    }
    try {
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (_req, file, cb) => {
    // Keep the original name but prefix a time-ish unique token from the
    // upload's own fieldname counter is not available; use a random suffix.
    const safe = file.originalname.replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    cb(null, `${globalThis.crypto.randomUUID().slice(0, 8)}__${safe}`);
  },
});

export const attachmentUpload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, files: 10 },
});

// Best-effort text extraction for the AI. Text-like files are read directly;
// PDFs/images are left as null (their filename still goes to the assistant).
async function extractText(filePath, mimetype) {
  try {
    if (
      (mimetype && (mimetype.startsWith('text/') || mimetype === 'application/json')) ||
      /\.(txt|md|csv|eml|log)$/i.test(filePath)
    ) {
      const buf = await fs.readFile(filePath);
      return buf.toString('utf8').slice(0, 20000);
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function listAttachments(complaintId) {
  return query(
    `SELECT id, complaint_id, filename, mimetype, size_bytes, uploaded_at,
            (extracted_text IS NOT NULL) AS has_text
       FROM complaint_attachments WHERE complaint_id = $1 ORDER BY uploaded_at DESC`,
    [complaintId],
  ).then((r) => r.rows);
}

// Attachment text for the assistant context (only where we could extract it).
export function attachmentTexts(complaintId) {
  return query(
    `SELECT filename, extracted_text FROM complaint_attachments
      WHERE complaint_id = $1 AND extracted_text IS NOT NULL ORDER BY uploaded_at`,
    [complaintId],
  ).then((r) => r.rows);
}

export async function saveAttachment(complaintId, file) {
  const text = await extractText(file.path, file.mimetype);
  const { rows } = await query(
    `INSERT INTO complaint_attachments
       (complaint_id, filename, mimetype, size_bytes, storage_path, extracted_text)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, complaint_id, filename, mimetype, size_bytes, uploaded_at,
               (extracted_text IS NOT NULL) AS has_text`,
    [complaintId, file.originalname, file.mimetype, file.size, file.path, text],
  );
  return rows[0];
}

export async function getAttachment(attId) {
  const { rows } = await query('SELECT * FROM complaint_attachments WHERE id = $1', [attId]);
  const a = rows[0];
  if (!a) return null;
  return { ...a, stream: () => createReadStream(a.storage_path) };
}

export async function deleteAttachment(attId) {
  const { rows } = await query(
    'DELETE FROM complaint_attachments WHERE id = $1 RETURNING storage_path',
    [attId],
  );
  if (!rows[0]) return false;
  await fs.unlink(rows[0].storage_path).catch(() => {});
  return true;
}
