import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { docxToText, isDocx } from '../lib/docx.js';

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

// Best-effort text extraction for the AI. Text-like files are read directly and
// the words are pulled out of Word documents; PDFs/images are left as null
// (their filename still goes to the assistant).
async function extractText(filePath, mimetype) {
  try {
    if (isDocx(mimetype, filePath)) {
      return docxToText(await fs.readFile(filePath)).slice(0, 20000);
    }
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

// Types the model can read directly — PDFs as documents, photos as images.
// Everything else it can only read if text was extracted on upload.
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const isPdf = (a) => a.mimetype === 'application/pdf' || /\.pdf$/i.test(a.filename || '');
// The type a photo really is. Mail systems often label one
// "application/octet-stream" or "image/jpg", which the AI refuses, so the
// file name decides when the label doesn't.
const EXT_IMAGE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
export function imageTypeOf(a) {
  const t = String(a?.mimetype || '').toLowerCase();
  if (IMAGE_TYPES.includes(t)) return t;
  if (t === 'image/jpg' || t === 'image/pjpeg') return 'image/jpeg';
  const ext = String(a?.filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return EXT_IMAGE[ext] || null;
}
const isImage = (a) => Boolean(imageTypeOf(a));

// The same document is one document: by its content hash, or (for one not
// hashed yet) by name and size. Keeps the first of each, and counts copies.
export function onePerDocument(rows) {
  const seen = new Map();
  const out = [];
  for (const a of rows) {
    const key = a.sha256 || `${a.filename}|${a.size_bytes}`;
    if (seen.has(key)) {
      seen.get(key).copies += 1;
      continue;
    }
    const first = { ...a, copies: 1 };
    seen.set(key, first);
    out.push(first);
  }
  return out;
}

export function listAttachments(complaintId) {
  return query(
    `SELECT id, complaint_id, filename, mimetype, size_bytes, uploaded_at, source_email_id, sha256, description,
            (extracted_text IS NOT NULL) AS has_text
       FROM complaint_attachments WHERE complaint_id = $1 ORDER BY uploaded_at DESC`,
    [complaintId],
  ).then((r) => onePerDocument(r.rows).map((a) => ({ ...a, ai_readable: a.has_text || isPdf(a) || isImage(a) })));
}

// The PDFs and photos on a complaint as content blocks for the AI, oldest
// first, each labelled with its filename. Capped so a pile of scans can't blow
// the request size: files beyond the cap are named but not sent, and the
// assistant is told so rather than reasoning as if it had read them.
const MAX_BLOCK_FILES = 10;
const MAX_BLOCK_BYTES = 20 * 1024 * 1024;

// maxFiles / newest: the automatic review sends only the latest couple of
// files (every PDF page costs AI credits on every review); the assistant
// asked for by a person sends them all, oldest first.
export async function attachmentBlocks(complaintId, { maxFiles = MAX_BLOCK_FILES, newest = false } = {}) {
  const { rows } = await query(
    `SELECT filename, mimetype, size_bytes, storage_path, sha256 FROM complaint_attachments
      WHERE complaint_id = $1 AND extracted_text IS NULL ORDER BY uploaded_at ${newest ? 'DESC' : 'ASC'}`,
    [complaintId],
  );
  // Each document once: the same scan on ten emails is one document, and
  // sending it ten times would only cost ten times as much.
  const unique = onePerDocument(rows);
  const blocks = [];
  const skipped = [];
  let bytes = 0;
  let files = 0;
  for (const a of unique.filter((r) => isPdf(r) || isImage(r))) {
    if (files >= Math.min(maxFiles, MAX_BLOCK_FILES) || bytes + (a.size_bytes || 0) > MAX_BLOCK_BYTES) {
      skipped.push(a.filename);
      continue;
    }
    let buf;
    try {
      buf = await fs.readFile(a.storage_path);
    } catch {
      skipped.push(a.filename);
      continue;
    }
    files += 1;
    bytes += buf.length;
    blocks.push({ type: 'text', text: `Attached evidence (third-party document): ${a.filename}` });
    blocks.push(
      isPdf(a)
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }
        : { type: 'image', source: { type: 'base64', media_type: imageTypeOf(a), data: buf.toString('base64') } },
    );
  }
  if (skipped.length) {
    blocks.push({
      type: 'text',
      text: `Not sent (too many or too large to include): ${skipped.join(', ')}. Do not assume their contents.`,
    });
  }
  return blocks;
}

// Attachment text for the assistant context (only where we could extract it).
export function attachmentTexts(complaintId) {
  return query(
    `SELECT filename, extracted_text FROM complaint_attachments
      WHERE complaint_id = $1 AND extracted_text IS NOT NULL ORDER BY uploaded_at`,
    [complaintId],
  ).then((r) => r.rows);
}

const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex');

// The document already on this complaint with the same content, if any.
async function alreadyOn(complaintId, hash) {
  return (await query(
    `SELECT id, complaint_id, filename, mimetype, size_bytes, uploaded_at, (extracted_text IS NOT NULL) AS has_text
       FROM complaint_attachments WHERE complaint_id = $1 AND sha256 = $2 LIMIT 1`,
    [complaintId, hash],
  )).rows[0] || null;
}

export async function saveAttachment(complaintId, file) {
  const hash = sha256Of(await fs.readFile(file.path));
  const existing = await alreadyOn(complaintId, hash);
  if (existing) {
    // Already on file: the new copy is removed rather than kept twice.
    await fs.unlink(file.path).catch(() => {});
    return { ...existing, duplicate: true };
  }
  const text = await extractText(file.path, file.mimetype);
  const { rows } = await query(
    `INSERT INTO complaint_attachments
       (complaint_id, filename, mimetype, size_bytes, storage_path, extracted_text, sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, complaint_id, filename, mimetype, size_bytes, uploaded_at,
               (extracted_text IS NOT NULL) AS has_text`,
    [complaintId, file.originalname, file.mimetype, file.size, file.path, text, hash],
  );
  return rows[0];
}

// Save a file that arrived attached to an email (it never went through
// multer), noting which email it came from. Same folder, naming and text
// extraction as an upload.
export async function saveAttachmentBuffer(complaintId, { filename, mimetype, buffer }, sourceEmailId) {
  const dir = path.join(UPLOAD_ROOT, complaintId);
  const rel = path.relative(UPLOAD_ROOT, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Invalid upload path');
  // The same file on another email of this complaint is already on file.
  const hash = sha256Of(buffer);
  const existing = await alreadyOn(complaintId, hash);
  if (existing) return { id: existing.id, filename: existing.filename, duplicate: true };
  await fs.mkdir(dir, { recursive: true });
  const safe = String(filename || 'attachment').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  const filePath = path.join(dir, `${globalThis.crypto.randomUUID().slice(0, 8)}__${safe}`);
  await fs.writeFile(filePath, buffer);
  const text = await extractText(filePath, mimetype);
  const { rows } = await query(
    `INSERT INTO complaint_attachments
       (complaint_id, filename, mimetype, size_bytes, storage_path, extracted_text, source_email_id, sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, filename`,
    [complaintId, filename || 'attachment', mimetype, buffer.length, filePath, text, sourceEmailId || null, hash],
  );
  return rows[0];
}

// Documents saved before hashes were kept: hashed in the background, a batch
// at a time (reading files, no AI), so duplicates already on file are shown
// and sent once. Returns how many were hashed.
export async function backfillAttachmentHashes({ limit = 500 } = {}) {
  const { rows } = await query(
    'SELECT id, storage_path FROM complaint_attachments WHERE sha256 IS NULL ORDER BY uploaded_at LIMIT $1', [limit],
  );
  let n = 0;
  for (const r of rows) {
    try {
      await query('UPDATE complaint_attachments SET sha256 = $2 WHERE id = $1', [r.id, sha256Of(await fs.readFile(r.storage_path))]);
      n += 1;
    } catch {
      // A missing file: marked so it isn't tried again every start-up.
      await query(`UPDATE complaint_attachments SET sha256 = 'missing:' || id WHERE id = $1`, [r.id]).catch(() => {});
    }
  }
  return n;
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

// --- Organisation procedure documents --------------------------------------
// An organisation's own complaints procedure, kept on its record so the
// deadlines can always be traced back to the document they came from.
// Stored under <uploadDir>/organisations/<orgId>/.

const ORG_ROOT = path.join(UPLOAD_ROOT, 'organisations');

const orgStorage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    const dir = path.join(ORG_ROOT, req.params.id);
    const rel = path.relative(ORG_ROOT, dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
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
    const safe = file.originalname.replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    cb(null, `${globalThis.crypto.randomUUID().slice(0, 8)}__${safe}`);
  },
});

export const orgDocumentUpload = multer({
  storage: orgStorage,
  limits: { fileSize: MAX_BYTES, files: 5 },
});

// Reading a procedure never needs the file on disk: it is read, the values
// come back for review, and the file is only stored once the record is saved.
export const procedureMemoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
});

const ORG_DOC_COLS = 'id, organisation_id, filename, mimetype, size_bytes, uploaded_at';

export function listOrgDocuments(orgId) {
  return query(
    `SELECT ${ORG_DOC_COLS} FROM organisation_documents
      WHERE organisation_id = $1 ORDER BY uploaded_at DESC`,
    [orgId],
  ).then((r) => r.rows);
}

export async function saveOrgDocument(orgId, file) {
  const { rows } = await query(
    `INSERT INTO organisation_documents
       (organisation_id, filename, mimetype, size_bytes, storage_path)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${ORG_DOC_COLS}`,
    [orgId, file.originalname, file.mimetype, file.size, file.path],
  );
  return rows[0];
}

export async function getOrgDocument(docId) {
  const { rows } = await query('SELECT * FROM organisation_documents WHERE id = $1', [docId]);
  const d = rows[0];
  if (!d) return null;
  return { ...d, stream: () => createReadStream(d.storage_path) };
}

export async function deleteOrgDocument(docId) {
  const { rows } = await query(
    'DELETE FROM organisation_documents WHERE id = $1 RETURNING storage_path',
    [docId],
  );
  if (!rows[0]) return false;
  await fs.unlink(rows[0].storage_path).catch(() => {});
  return true;
}

// Before an organisation is deleted: its rows cascade, but the files would be
// left on disk with nothing pointing at them.
export async function removeOrgDocumentFiles(orgId) {
  await removeOrgFiles(await orgDocumentFiles(orgId));
}

// An organisation's document files, read so they can be removed only once
// the organisation itself has been deleted (a delete that fails keeps them).
export async function orgDocumentFiles(orgId) {
  const { rows } = await query(
    'SELECT storage_path FROM organisation_documents WHERE organisation_id = $1',
    [orgId],
  );
  return { orgId, paths: rows.map((r) => r.storage_path) };
}

export async function removeOrgFiles({ orgId, paths }) {
  for (const p of paths) await fs.unlink(p).catch(() => {});
  await fs.rmdir(path.join(ORG_ROOT, orgId)).catch(() => {});
}
