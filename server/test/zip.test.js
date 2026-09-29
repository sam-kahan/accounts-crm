import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { zipStore, safeName } from '../src/lib/zip.js';

// Read a stored zip back through its central directory.
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const at = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localName = buf.readUInt16LE(at + 26);
    const data = buf.subarray(at + 30 + localName, at + 30 + localName + size);
    assert.equal(crc32(data) >>> 0, buf.readUInt32LE(p + 16));
    out.push({ name, data: data.toString('utf8') });
    p += 46 + nameLen;
  }
  return out;
}

test('a zip reads back file for file, names and contents', () => {
  const z = zipStore([
    { name: '00 Summary.txt', data: 'Hello £120' },
    { name: 'Emails/001 2026-07-01 SENT – Formal complaint.txt', data: 'Dear team' },
    { name: 'Documents/bill.pdf', data: Buffer.from([1, 2, 3]) },
    { name: 'Documents/bill.pdf', data: 'second' },
  ]);
  const files = readZip(z);
  assert.deepEqual(files.map((f) => f.name), ['00 Summary.txt', 'Emails/001 2026-07-01 SENT – Formal complaint.txt', 'Documents/bill.pdf', 'Documents/bill (2).pdf']);
  assert.equal(files[0].data, 'Hello £120');
  assert.equal(files[3].data, 'second');
});

test('safe file names', () => {
  assert.equal(safeName('RE: 28131442 / Stage 2?'), 'RE 28131442 Stage 2');
  assert.equal(safeName(''), 'untitled');
  assert.equal(safeName('x'.repeat(200)).length, 80);
});
