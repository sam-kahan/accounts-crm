import { query } from '../db/pool.js';

// Match a name read off a document to a saved organisation, through the usual
// noise (Ltd/Limited, "&"/"and", punctuation, "the"). Only an exact match after
// cleaning counts — a half-right guess would apply another body's procedure.
// The client has the same rule for the Log form (Complaints.jsx).
export function orgKey(name) {
  return String(name || '').toLowerCase()
    .replace(/&/g, ' and ').replace(/\blimited\b/g, 'ltd').replace(/\bthe\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function findOrgByName(name) {
  const k = orgKey(name);
  if (!k) return null;
  const { rows } = await query('SELECT * FROM organisations');
  return rows.find((o) => orgKey(o.name) === k) || null;
}
