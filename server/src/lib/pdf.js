// A plain-text PDF, no dependency (like lib/zip.js and lib/docx.js): A4 pages,
// a bold heading, then the text in Courier, wrapped to the page. Used to turn
// an email on file into a document that can go with another email (a copy of
// "our email of 16 September" that an organisation asked for).
//
// Deterministic: the same text always makes the same bytes (no creation date
// or random id), so the attachment store's hash recognises a copy made twice.

const PAGE_W = 595.28; // A4, points
const PAGE_H = 841.89;
const MARGIN = 50;
const SIZE = 10;
const LEAD = 13;
const CHAR_W = SIZE * 0.6; // Courier is 600/1000 em
export const LINE_CHARS = Math.floor((PAGE_W - 2 * MARGIN) / CHAR_W);
const TITLE_SIZE = 13;
const LINES_PER_PAGE = Math.floor((PAGE_H - 2 * MARGIN - 30) / LEAD);

// Unicode → WinAnsi (the standard fonts' encoding). Latin-1 maps to itself;
// the few typographic characters an email is full of have their own codes.
const WIN = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86],
  [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95],
  [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

function winAnsi(str) {
  const out = [];
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp === 0x09) out.push(0x20, 0x20, 0x20, 0x20);
    else if (cp >= 0x20 && cp <= 0x7e) out.push(cp);
    else if (cp >= 0xa0 && cp <= 0xff) out.push(cp === 0xa0 ? 0x20 : cp);
    else if (WIN.has(cp)) out.push(WIN.get(cp));
    else if (cp === 0x2010 || cp === 0x2011 || cp === 0x2212) out.push(0x2d);
    else if (cp >= 0x2000 && cp <= 0x200b) out.push(0x20);
    else out.push(0x3f); // "?": a character the font can't show
  }
  return out;
}

// A PDF string literal from WinAnsi bytes.
function literal(bytes) {
  let s = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) s += `\\${b.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(b);
  }
  return `${s})`;
}

// Wrap text to `width` characters: at a space where there is one, mid-word
// only for a word longer than a line (a long link). Blank lines are kept.
export function wrapText(text, width = LINE_CHARS) {
  const lines = [];
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    let line = raw.replace(/\t/g, '    ').replace(/\s+$/, '');
    if (!line) { lines.push(''); continue; }
    while ([...line].length > width) {
      const chars = [...line];
      let cut = chars.slice(0, width + 1).join('').lastIndexOf(' ');
      if (cut <= 0) cut = chars.slice(0, width).join('').length;
      lines.push(line.slice(0, cut).replace(/\s+$/, ''));
      line = line.slice(cut).replace(/^ +/, '');
    }
    lines.push(line);
  }
  return lines;
}

// { title, text } → a PDF Buffer.
export function textPdf({ title = '', text = '' }) {
  const lines = wrapText(text);
  const pages = [];
  for (let i = 0; i < Math.max(1, lines.length); i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));
  const titleBytes = winAnsi(String(title).replace(/\s+/g, ' ').trim());

  // Objects: 1 catalog, 2 pages, 3 Courier, 4 Helvetica-Bold, then a page and
  // its content stream for each page.
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((pageLines, i) => {
    const pageNo = 5 + i * 2;
    let top = PAGE_H - MARGIN;
    let stream = '';
    if (i === 0 && titleBytes.length) {
      stream += `BT /F2 ${TITLE_SIZE} Tf ${MARGIN} ${(top - TITLE_SIZE).toFixed(2)} Td ${literal(titleBytes)} Tj ET\n`;
      top -= 30;
    }
    stream += `BT /F1 ${SIZE} Tf ${LEAD} TL ${MARGIN} ${(top - SIZE).toFixed(2)} Td\n`;
    pageLines.forEach((l, n) => { stream += `${n ? 'T* ' : ''}${literal(winAnsi(l))} Tj\n`; });
    stream += 'ET\n';
    if (pages.length > 1) {
      const foot = winAnsi(`Page ${i + 1} of ${pages.length}`);
      stream += `BT /F1 8 Tf ${MARGIN} ${(MARGIN / 2).toFixed(2)} Td ${literal(foot)} Tj ET\n`;
    }
    objs[pageNo] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageNo + 1} 0 R >>`;
    objs[pageNo + 1] = { stream };
  });

  // Every byte of the body is < 0x80 except inside strings, which are octal
  // escaped, so string length = byte length.
  const parts = ['%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'];
  const offsets = [];
  let pos = Buffer.byteLength(parts[0], 'latin1');
  for (let n = 1; n < objs.length; n += 1) {
    offsets[n] = pos;
    const o = objs[n];
    const body = typeof o === 'string'
      ? `${n} 0 obj\n${o}\nendobj\n`
      : `${n} 0 obj\n<< /Length ${Buffer.byteLength(o.stream, 'latin1')} >>\nstream\n${o.stream}endstream\nendobj\n`;
    parts.push(body);
    pos += Buffer.byteLength(body, 'latin1');
  }
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n += 1) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  parts.push(xref, `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`);
  return Buffer.from(parts.join(''), 'latin1');
}
