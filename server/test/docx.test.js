import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  docxToText,
  documentXmlToText,
  isDocx,
  isLegacyDoc,
  DocxError,
} from '../src/lib/docx.js';

// --- a .docx to test against ------------------------------------------------
// Building one here beats checking a binary fixture into the repo: the test
// says exactly what is in the file it is reading. CRCs are left at zero — the
// reader takes sizes and offsets from the central directory and never checks
// them, which is the whole of what a Word file needs.

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data, store = false } of files) {
    const body = store ? data : deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(store ? 0 : 8, 10);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

const para = (...runs) =>
  `<w:p><w:r>${runs.map((t) => `<w:t xml:space="preserve">${t}</w:t>`).join('')}</w:r></w:p>`;

const wordDoc = (body) =>
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body>${body}</w:body></w:document>`,
    'utf8',
  );

function invoiceDocx() {
  return zip([
    // Deliberately out of order in the file: the reader puts the letterhead
    // first, the body next and the footer last whatever order they are stored.
    { name: 'word/footer1.xml', data: wordDoc(para('Payment within 14 days')) },
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>', 'utf8') },
    {
      name: 'word/document.xml',
      data: wordDoc(
        // Word splits a line across runs mid-word all the time.
        para('Invoice INV-', '2091') +
          para('14 Sefton Road, Bootle L20 3AA') +
          `<w:tbl><w:tr><w:tc>${para('Labour')}</w:tc><w:tc>${para('90.00')}</w:tc></w:tr></w:tbl>`,
      ),
    },
    { name: 'word/header1.xml', data: wordDoc(para('Kelly &amp; Sons Plumbing')), store: true },
  ]);
}

test('docxToText reads the letterhead, the body and the footer, in that order', () => {
  const text = docxToText(invoiceDocx());
  const lines = text.split('\n').filter(Boolean);

  assert.equal(lines[0], 'Kelly & Sons Plumbing'); // header first, entities decoded
  assert.equal(lines[1], 'Invoice INV-2091'); // runs joined with nothing between them
  assert.equal(lines[2], '14 Sefton Road, Bootle L20 3AA');
  assert.equal(lines[3], 'Labour\t90.00'); // a table row stays one line
  assert.equal(lines.at(-1), 'Payment within 14 days'); // footer last
});

test('docxToText reads a stored (uncompressed) part as well as a deflated one', () => {
  // The header above is stored, the rest deflated — both came back.
  assert.match(docxToText(invoiceDocx()), /Kelly & Sons Plumbing[\s\S]*Labour/);
});

test('docxToText rejects a legacy .doc with an answer the user can act on', () => {
  const ole = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(200),
  ]);
  assert.throws(
    () => docxToText(ole),
    (err) => err instanceof DocxError && /\.docx or PDF/.test(err.message),
  );
});

test('docxToText rejects a file that is not a Word document', () => {
  assert.throws(() => docxToText(Buffer.from('just some text')), DocxError);
  // A zip, but not a Word one.
  assert.throws(() => docxToText(zip([{ name: 'notes.txt', data: Buffer.from('hi') }])), DocxError);
  assert.throws(() => docxToText(Buffer.alloc(0)), DocxError);
});

test('docxToText refuses a document with no text rather than returning nothing', () => {
  // A scan pasted into Word: all picture, no words.
  const pictureOnly = zip([
    { name: 'word/document.xml', data: wordDoc('<w:p><w:r><w:drawing/></w:r></w:p>') },
  ]);
  assert.throws(
    () => docxToText(pictureOnly),
    (err) => err instanceof DocxError && /no text/.test(err.message),
  );
});

test('documentXmlToText keeps breaks and drops field codes and deleted text', () => {
  const xml = wordDoc(
    `<w:p><w:r><w:t>Total</w:t><w:tab/><w:t>£108.00</w:t><w:br/><w:t>Ref </w:t>` +
      `<w:instrText>MERGEFIELD Ref</w:instrText><w:delText>OLD-1</w:delText><w:t>NEW-2</w:t></w:r></w:p>`,
  ).toString('utf8');

  assert.equal(documentXmlToText(xml), 'Total\t£108.00\nRef NEW-2');
});

test('documentXmlToText treats whitespace between tags as indentation', () => {
  // Some editors write the part pretty-printed. The newlines between the tags
  // are not blank lines in the document, and must not read as any.
  const xml = `<w:body>
    <w:p>
      <w:r><w:t xml:space="preserve">Invoice No: </w:t></w:r>
      <w:r><w:t>7741</w:t></w:r>
    </w:p>
    <w:p><w:r><w:t>Date: 12/08/2026</w:t></w:r></w:p>
  </w:body>`;

  assert.equal(documentXmlToText(xml), 'Invoice No: 7741\nDate: 12/08/2026');
});

test('isDocx and isLegacyDoc tell the two Word formats apart', () => {
  assert.equal(
    isDocx('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'inv.docx'),
    true,
  );
  // Browsers and mail clients send Word files as octet-stream often enough that
  // the extension has to count on its own.
  assert.equal(isDocx('application/octet-stream', 'invoice 44.DOCX'), true);
  assert.equal(isDocx('application/pdf', 'invoice.pdf'), false);

  assert.equal(isLegacyDoc('application/msword', 'invoice.doc'), true);
  assert.equal(isLegacyDoc('application/octet-stream', 'invoice.doc'), true);
  assert.equal(isLegacyDoc('application/octet-stream', 'invoice.docx'), false);
});
