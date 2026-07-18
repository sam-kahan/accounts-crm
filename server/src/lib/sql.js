// Build a parameterized SQL SET clause from column→value pairs.
//
// A value of `undefined` means "the caller omitted this field" → skip it (leave
// the column unchanged). A value of `null` is kept, so a caller CAN clear a
// nullable column by sending an explicit null — the thing COALESCE-based updates
// can't do, because COALESCE can't tell "omitted" from "set to null".
//
// Params are numbered starting AFTER `afterParam` (default 1, reserving $1 for
// the WHERE id). Column names come from trusted, hardcoded keys — never user
// input — and all values are parameterized, so this is injection-safe.
//
// Returns { clause, values } where clause is e.g. "a = $2, b = $3" (empty string
// if every field was omitted).
export function buildUpdateSet(fields, afterParam = 1) {
  const parts = [];
  const values = [];
  let n = afterParam;
  for (const [col, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    n += 1;
    parts.push(`${col} = $${n}`);
    values.push(val);
  }
  return { clause: parts.join(', '), values };
}
