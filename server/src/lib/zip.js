import { crc32 } from 'node:zlib';

// ---------------------------------------------------------------------------
// A zip file of the files given, stored (not compressed: PDFs and photos,
// most of an evidence pack, don't compress anyway). No dependency: the local
// headers, the central directory and the end record, per the zip format.
// Names are UTF-8 (flag bit 11). For the ombudsman evidence download.
// ---------------------------------------------------------------------------

function dosTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// `files`: [{ name, data (Buffer or string), date? }]. Returns a Buffer.
export function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const seen = new Set();
  for (const f of files) {
    // One name each: a second "letter.pdf" becomes "letter (2).pdf".
    let name = f.name;
    for (let n = 2; seen.has(name.toLowerCase()); n += 1) name = f.name.replace(/(\.[^./]+)?$/, (ext) => ` (${n})${ext || ''}`);
    seen.add(name.toLowerCase());
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const { time, date } = dosTime(f.date || new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// A file name safe on every system: no path separators or reserved
// characters, not too long. `keepExt`: a long name is shortened before its
// extension, never through it (a "statement.pdf" that loses ".pdf" won't open).
export function safeName(s, max = 80, { keepExt = false } = {}) {
  const clean = String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'untitled';
  if (clean.length <= max) return clean;
  const ext = keepExt ? (clean.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0] : '';
  return `${clean.slice(0, max - ext.length).trim()}${ext}`;
}
