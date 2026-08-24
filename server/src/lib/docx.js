import { inflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Reading Word documents (.docx) — enough of one to get the words out.
//
// Contractors send invoices as Word files as often as PDFs, and Claude can't be
// handed a .docx the way it can a PDF or a photo: there is no document block for
// it. So we pull the text out here and send that instead, wrapped in the usual
// <untrusted_content> markers (which is actually the SAFER of the two paths — a
// PDF can only be warned about in the system prompt).
//
// A .docx is a zip of XML parts. Rather than take a dependency for it, this
// reads the central directory and inflates the parts we want: everything here
// is node:zlib plus offsets from the zip spec. Legacy .doc (the pre-2007 binary
// OLE format) is NOT readable this way and is detected so the user gets told to
// save it as .docx or PDF rather than a puzzling failure.
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

// A Word document is XML: verbose, but a whole invoice is a few tens of KB.
// The cap is a zip-bomb guard, not a size we ever expect to reach.
const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;

// The .doc / .xls binary format: an OLE compound file, not a zip.
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export class DocxError extends Error {}

const DOCX_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template', // .dotx
  'application/vnd.ms-word.document.macroEnabled.12', // .docm
  'application/vnd.ms-word.template.macroEnabled.12', // .dotm
];

export function isDocx(mimetype, filename = '') {
  return DOCX_TYPES.includes(mimetype) || /\.(docx|dotx|docm|dotm)$/i.test(filename);
}

// The old binary format. Worth naming separately: the file is a Word document,
// it just isn't one we can read, and "save it as .docx" is the whole fix.
export function isLegacyDoc(mimetype, filename = '', buffer = null) {
  if (mimetype === 'application/msword' || /\.(doc|dot)$/i.test(filename)) return true;
  return Buffer.isBuffer(buffer) && buffer.subarray(0, 8).equals(OLE_MAGIC);
}

// --- zip ------------------------------------------------------------------

function findEndOfCentralDirectory(buf) {
  // The record is 22 bytes plus a comment of up to 64 KB, so scan back from the
  // end rather than assuming it sits at a fixed offset.
  const floor = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readCentralDirectory(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd === -1) throw new DocxError('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const entry = {
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      localOffset: buf.readUInt32LE(p + 42),
    };
    entries.set(buf.toString('utf8', p + 46, p + 46 + nameLen), entry);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry) {
  // 0xFFFFFFFF means the real value lives in a zip64 extra field. Word only
  // writes those for files far larger than any invoice, so say so plainly
  // instead of half-reading one.
  if (entry.localOffset === 0xffffffff || entry.compressedSize === 0xffffffff) {
    throw new DocxError('zip64 not supported');
  }
  const lh = entry.localOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== LOCAL_SIG) {
    throw new DocxError('corrupt zip entry');
  }
  const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data.subarray(0, MAX_PART_BYTES);
  if (entry.method !== 8) throw new DocxError('unsupported compression');
  try {
    return inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES });
  } catch {
    throw new DocxError('corrupt zip entry');
  }
}

// --- XML ------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// WordprocessingML puts the words in <w:t> and nothing else in the file is
// text: whitespace between the tags is indentation, not spacing, and stripping
// tags wholesale would turn a prettily-printed part into a blank line between
// every paragraph. So only the elements that mean something are read — the text
// itself, and the ones that end a line or a cell.
//
// Runs split mid-word ("Inv" + "oice #12"), so consecutive <w:t> are joined
// with nothing between them.
const TOKEN =
  /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(br|cr|tab)\b[^>]*\/?>|<\/w:(p|tc|tr)>/g;

// Field codes (page numbers, merge fields) and text struck out by tracked
// changes are not part of what the document says.
const DROPPED = /<w:instrText[\s\S]*?<\/w:instrText>|<w:delText[\s\S]*?<\/w:delText>/g;

export function documentXmlToText(xml) {
  let out = '';
  // Table cells sit side by side on the page, so a cell ends in a tab and only
  // the row ends the line — otherwise "Labour  90.00" arrives as two lines and
  // the figure is orphaned from what it is for. The paragraph that closes a
  // cell is the cell ending, not a line of its own, hence the trimming.
  const endWith = (ch, trim) => {
    out = out.replace(trim, '');
    out += ch;
  };

  for (const m of String(xml).replace(DROPPED, '').matchAll(TOKEN)) {
    if (m[1] !== undefined) out += decodeEntities(m[1]);
    else if (m[2]) out += m[2] === 'tab' ? '\t' : '\n';
    else if (m[3] === 'p') out += '\n';
    else if (m[3] === 'tc') endWith('\t', /\n+$/);
    else endWith('\n', /\t+$/); // </w:tr>
  }

  return out
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- the whole document ---------------------------------------------------

// Header and footer parts carry the letterhead: on a contractor's invoice that
// is usually their business name, address and VAT number, so they are read
// alongside the body rather than thrown away.
function partOrder(name) {
  if (name === 'word/document.xml') return 1;
  if (/^word\/header\d*\.xml$/.test(name)) return 0;
  if (/^word\/footer\d*\.xml$/.test(name)) return 2;
  return -1;
}

export function docxToText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new DocxError('The Word document was empty.');
  }
  if (buffer.subarray(0, 8).equals(OLE_MAGIC)) {
    throw new DocxError(
      'That is an older Word (.doc) file, which can’t be read. Save it as .docx or PDF and upload it again.',
    );
  }

  let entries;
  try {
    entries = readCentralDirectory(buffer);
  } catch {
    throw new DocxError('That file couldn’t be opened as a Word document.');
  }
  if (!entries.has('word/document.xml')) {
    throw new DocxError('That file couldn’t be opened as a Word document.');
  }

  const parts = [...entries.keys()]
    .filter((name) => partOrder(name) >= 0)
    .sort((a, b) => partOrder(a) - partOrder(b) || a.localeCompare(b));

  const text = parts
    .map((name) => {
      try {
        return documentXmlToText(readEntry(buffer, entries.get(name)).toString('utf8'));
      } catch {
        // A header we can't inflate must not cost us the body of the invoice.
        if (name === 'word/document.xml') throw new DocxError('That Word document couldn’t be read.');
        return '';
      }
    })
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_TEXT_CHARS);

  if (!text.trim()) {
    throw new DocxError(
      'That Word document has no text in it — if the invoice is a picture inside the document, upload the picture or a PDF instead.',
    );
  }
  return text;
}
