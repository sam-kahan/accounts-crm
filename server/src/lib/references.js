// Every organisation's reference on an email, each labelled. A complaint
// against two organisations (LCS collecting for EDF Energy) has two
// references, and an email to either must quote the one it is for as
// "Your reference" and the other by that organisation's name, so whoever
// reads it can find both records. Pure; the client has the same rule
// (client/src/api.js#withReferences) for the drafts it builds itself.

const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The labelled lines for an email to the organisation `toKey` ('main' or a
// party id; null for someone who is none of them, e.g. the ombudsman, when
// every one is named). `tracks`: [{ key, org_name, reference }], main first.
// Only references we know; none known gives no lines.
export function referenceLines(tracks, toKey = null) {
  const known = (tracks || []).filter((t) => t && String(t.reference || '').trim());
  const mine = known.filter((t) => toKey && t.key === toKey);
  const others = known.filter((t) => !(toKey && t.key === toKey));
  return [
    ...mine.map((t) => `Your reference: ${t.reference.trim()}`),
    ...others.map((t) => `${t.org_name} reference: ${t.reference.trim()}`),
  ];
}

// The body with every reference in it: any line whose reference the email
// doesn't already quote is added under the greeting (or at the top), so a
// draft that already quotes both is left exactly as written.
export function withReferences(body, lines) {
  const text = String(body || '');
  if (!text.trim() || !lines?.length) return text;
  const flat = key(text);
  const missing = lines.filter((l) => {
    const ref = key(l.slice(l.indexOf(':') + 1));
    return ref.length >= 3 && !flat.includes(ref);
  });
  if (!missing.length) return text;
  const block = missing.join('\n');
  const greet = text.match(/^\s*((?:dear|hello|hi|good (?:morning|afternoon|evening))\b[^\n]*)\n+/i);
  if (greet) return `${greet[1]}\n\n${block}\n\n${text.slice(greet[0].length)}`;
  return `${block}\n\n${text.replace(/^\s+/, '')}`;
}
