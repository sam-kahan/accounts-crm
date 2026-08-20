// Minimal CSV writer for the commission reports.
//
// Cells are quoted whenever they contain a comma, quote, or newline, and inner
// quotes are doubled per RFC 4180. Cells that *start* with a formula character
// are additionally prefixed with an apostrophe: a lot of what lands in these
// reports (invoice numbers, work descriptions, property addresses) is text a
// contractor wrote — or that an AI read off their PDF — and Excel would happily
// execute `=cmd|...` from a downloaded file.
const NEEDS_QUOTES = /[",\r\n]/;
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  if (NEEDS_QUOTES.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(values) {
  return values.map(csvCell).join(',');
}

// Build a full CSV document. `columns` is [{ key, label }]; `rows` are plain
// objects. Excel needs the BOM to read UTF-8 (£ signs) correctly.
export function toCsv(columns, rows, { bom = true } = {}) {
  const lines = [csvRow(columns.map((c) => c.label ?? c.key))];
  for (const row of rows) lines.push(csvRow(columns.map((c) => row[c.key])));
  return `${bom ? '﻿' : ''}${lines.join('\r\n')}\r\n`;
}
