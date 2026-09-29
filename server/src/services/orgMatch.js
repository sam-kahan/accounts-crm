import { query } from '../db/pool.js';

// ---------------------------------------------------------------------------
// Matching names read off emails and documents to what is already on file.
// Names come through with noise (Ltd/Limited, "&"/"and", "the") and are often
// shortened ("LivingCity" for "Livingcity Asset Management Limited"), so there
// are two tiers: an exact match after cleaning, then a prefix match — one name
// is the start of the other — accepted only when exactly one saved
// organisation fits and the shorter name isn't trivially short. A half-right
// guess would apply another body's procedure, so anything ambiguous is no match.
// ---------------------------------------------------------------------------

// The further organisations on each complaint (migration 029), for SELECTs
// FROM complaints c that feed the matching: their names and their references.
export const PARTY_COLS =
  `(SELECT coalesce(array_agg(p.org_name ORDER BY p.created_at), '{}') FROM complaint_parties p WHERE p.complaint_id = c.id) AS party_names,
   (SELECT coalesce(array_agg(p.reference ORDER BY p.created_at) FILTER (WHERE p.reference IS NOT NULL), '{}')
      FROM complaint_parties p WHERE p.complaint_id = c.id) || c.other_references AS party_refs,
   c.merged_refs AS merged_refs`;

export function orgKey(name) {
  return String(name || '').toLowerCase()
    .replace(/&/g, ' and ').replace(/\blimited\b/g, 'ltd').replace(/\bthe\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const compact = (name) => orgKey(name).replace(/\s+/g, '');

// Words that say what kind of body it is rather than which one. A shortened
// name matches a longer one only if all it leaves off is words like these:
// "LivingCity" is "Livingcity Asset Management Ltd", but "Liverpool" is not
// "Liverpool Mutual Homes". Council words are NOT generic: a bare place
// ("Liverpool") must never be taken for its council ("Liverpool City
// Council"), since the place name turns up in every address.
const GENERIC = /^(?:ltd|plc|llp|uk|group|holdings|asset|management|services|service|property|properties|estates|the|and|company|co|limited)*$/;

// What a supplier or collector adds to its brand without being a different
// body: "Octopus" is "Octopus Energy", "CDER" is "CDER Group". Only ever as
// trailing words after the whole brand, and only when exactly one saved
// organisation fits (matchOrgName), so "Scottish" can't pick between
// "Scottish Power" and "Scottish Water". Housing words are left out: a place
// ("Liverpool") must never become a landlord ("Liverpool Homes").
const SECTOR = new Set(['energy', 'gas', 'electric', 'electricity', 'power', 'water', 'utilities', 'utility',
  'supply', 'supplies', 'retail', 'debt', 'recovery', 'recoveries', 'collection', 'collections', 'financial', 'finance', 'solutions']);
const GENERIC_WORD = new Set(['ltd', 'plc', 'llp', 'uk', 'group', 'holdings', 'services', 'service', 'company', 'co', 'limited', 'and']);
const COUNCIL_WORDS = new Set(['city', 'metropolitan', 'borough', 'district', 'county', 'council', 'of']);

// Letters apart (insertions, deletions, substitutions), stopping past `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Are two names the same organisation? Any of:
//   - exact after cleaning (Ltd/Limited, &/and, "the", punctuation);
//   - one is the other with only generic words added, at least 5 letters in
//     common ("LivingCity" is "Livingcity Asset Management Ltd");
//   - the same once company words are dropped ("CDER" is "CDER Group",
//     "UK Power Networks" is "UK Power Networks Ltd");
//   - one is the other's whole brand plus sector words ("Octopus" is
//     "Octopus Energy", "OVO" is "OVO Energy");
//   - two councils for the same place ("Liverpool Council" is "Liverpool
//     City Council") — never a bare place and its council;
//   - a long name one letter out ("Brittish Gas"): a typo, not another body.
export function sameOrgName(a, b) {
  const ka = orgKey(a);
  const kb = orgKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const ca = compact(a);
  const cb = compact(b);
  const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  if (short.length >= 5 && long.startsWith(short) && GENERIC.test(long.slice(short.length))) return true;

  const wa = ka.split(' ');
  const wb = kb.split(' ');
  const core = (w) => w.filter((x) => !GENERIC_WORD.has(x)).join('');
  const coreA = core(wa);
  const coreB = core(wb);
  if (coreA.length >= 3 && coreA === coreB) return true;

  const [ws, wl] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const brand = ws.filter((x) => !GENERIC_WORD.has(x));
  const rest = wl.filter((x) => !GENERIC_WORD.has(x));
  if (brand.join('').length >= 3 && brand.length < rest.length &&
      brand.every((x, i) => rest[i] === x) && rest.slice(brand.length).every((x) => SECTOR.has(x))) return true;

  const isCouncil = (w) => w.includes('council');
  if (isCouncil(wa) && isCouncil(wb)) {
    const place = (w) => w.filter((x) => !COUNCIL_WORDS.has(x) && !GENERIC_WORD.has(x)).join(' ');
    if (place(wa) && place(wa) === place(wb)) return true;
  }

  // A one-letter slip in a long name, but never where a place is what tells
  // two bodies apart ("Bolton Council" / "Boston Council", "Harrow" /
  // "Barrow"): not for councils, and only when the first four letters agree.
  const placeLike = (w) => w.some((x) => COUNCIL_WORDS.has(x));
  if (placeLike(wa) || placeLike(wb) || ca.slice(0, 4) !== cb.slice(0, 4)) return false;
  return short.length >= 10 && editDistance(ca, cb, 1) <= 1;
}

// The one saved organisation a name refers to: an exact match, or else the
// only one it matches by sameOrgName. Two candidates is no match.
export function matchOrgName(orgs, name) {
  const k = orgKey(name);
  if (!k) return null;
  const exact = orgs.find((o) => orgKey(o.name) === k);
  if (exact) return exact;
  const hits = orgs.filter((o) => sameOrgName(o.name, name));
  return hits.length === 1 ? hits[0] : null;
}

// Webmail and the like: an address there says nothing about which body sent it.
const SHARED_DOMAINS = /^(?:gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|btinternet|sky|virginmedia|talktalk|protonmail|mail)\./i;
export const domainOf = (addr) => String(addr || '').toLowerCase().split('@')[1]?.trim() || null;

// The saved organisation a name — or failing that, the email domains it
// wrote from or is written to at — refers to. A domain counts only when
// exactly one organisation's complaints address is at it, and never our own
// or a webmail one.
export function matchOrg(orgs, { name, domains = [], ourDomain = '' } = {}) {
  const byName = name ? matchOrgName(orgs, name) : null;
  if (byName) return byName;
  const ours = String(ourDomain || '').toLowerCase();
  const want = new Set(domains.map((d) => String(d || '').toLowerCase()).filter((d) => d && d !== ours && !SHARED_DOMAINS.test(d)));
  if (!want.size) return null;
  const hits = orgs.filter((o) => want.has(domainOf(o.complaints_email)));
  return hits.length === 1 ? hits[0] : null;
}

export async function findOrgByName(name, { domains = [], ourDomain = '' } = {}) {
  const { rows } = await query('SELECT * FROM organisations');
  return matchOrg(rows, { name, domains, ourDomain });
}

// A UK postcode in an address, normalised ("l87ad" → "L8 7AD"), or null.
export function postcodeOf(text) {
  const m = String(text || '').toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/);
  return m ? `${m[1]} ${m[2]}` : null;
}

// The numbers that identify a property in an address — flat and house (or
// building) numbers, with the postcode taken out: "Apartment 309, 2
// Moorfields, L2 2BT" is {309, 2}; "A08 and A09 Bateson Building" is {A8, A9}.
// Leading zeros are dropped so A08 and A8 agree.
export function addressNumbers(text) {
  const t = String(text || '').toUpperCase()
    .replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g, ' '); // the postcode
  const out = new Set();
  for (const m of t.matchAll(/\b([A-Z]?)0*(\d+)([A-Z]?)\b/g)) out.add(`${m[1]}${m[2]}${m[3]}`);
  return out;
}

// Kept for callers that want the single most specific number: the flat
// number if it's marked as one, else the first number.
export function unitOf(text) {
  const t = String(text || '').toUpperCase();
  const flat = t.match(/\b(?:APARTMENT|APT|FLAT|UNIT|SUITE|ROOM)\.?\s*(?:NO\.?\s*)?([A-Z]?\d+[A-Z]?)\b/);
  const lead = flat ? null : t.match(/^\s*([A-Z]?\d+[A-Z]?)\b/);
  const u = (flat || lead)?.[1];
  return u ? u.replace(/^([A-Z]?)0+(\d)/, '$1$2') : null;
}

// Same postcode, and the numbers of one address are all found in the other:
// "Flat 2, 10 X Road" and "10 X Road" are the same property written more and
// less fully, but "Apartment 309, 2 Moorfields" and "Apartment 326,
// 2 Moorfields" are two flats in one block. An address with no numbers
// doesn't decide it either way.
export function sameProperty(pa, pb) {
  if (postcodeOf(pa) !== postcodeOf(pb)) return false;
  const a = addressNumbers(pa);
  const b = addressNumbers(pb);
  if (!a.size || !b.size) return true;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  return [...small].every((n) => big.has(n));
}

// The ACCOUNT NUMBERS on a record: the ones read off its emails
// (account_numbers), plus any account-number-like token in its subject
// ("Incorrect final billing on account A43325464"). The account number is the
// main key for a complaint: one complaint's emails all carry it, and two
// complaints to one supplier about different properties never share it.
// Normalised (upper case, no spaces or dashes) so "A433 25464" matches
// "A43325464". Dates, amounts and short numbers are left out.
const norm = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const refLike = (k) => k.length >= 5 && k.length <= 24 && (k.match(/\d/g) || []).length >= 5;

export function accountsOf(x) {
  const out = new Set();
  for (const n of Array.isArray(x?.account_numbers) ? x.account_numbers : []) {
    const k = norm(n);
    if (refLike(k)) out.add(k);
  }
  for (const tok of String(x?.subject || '').split(/[\s,;:()[\]]+/)) {
    if (/^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/.test(tok)) continue; // a date
    if (/[£$€]/.test(tok) || /\d\.\d{2}$/.test(tok)) continue; // an amount of money
    const k = norm(tok);
    if (refLike(k)) out.add(k);
  }
  return out;
}

// Case references (theirs and ours): the same one means the same complaint,
// but a different one proves nothing (a new case can be opened on the same
// complaint).
export function refsOf(x) {
  const out = new Set();
  // A complaint with more than one organisation carries each one's reference.
  for (const v of [x?.reference, x?.our_reference, ...(Array.isArray(x?.party_refs) ? x.party_refs : [])]) {
    const k = norm(v);
    if (refLike(k)) out.add(k);
  }
  return out;
}

// Every account-like number written in a complaint's references, word by
// word ("Council Tax ref 58669277 / CDER Reference 27308462" gives both).
// An import sometimes files the account number as "their reference", so the
// account-number rule looks here too.
export function refNumbersOf(x) {
  const out = new Set();
  for (const v of [x?.reference, ...(Array.isArray(x?.party_refs) ? x.party_refs : [])]) {
    for (const tok of String(v || '').split(/[\s,;:()[\]/]+/)) {
      const k = norm(tok);
      if (refLike(k) && k.length >= 6) out.add(k);
    }
  }
  return out;
}

const DAY = 86400000;
const nearInTime = (a, b) => Boolean(a && b) &&
  Math.abs(new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) <= 14 * DAY;
const shares = (a, b) => [...a].some((v) => b.has(v));

// Are two records (found threads, or a found thread and a complaint) about
// the same issue, and how sure is that? Same organisation first; then, in
// order — the account number first, because it is always the account number:
//   - the same account number: the same complaint, for certain
//   - both have account numbers and they differ: different complaints, even
//     at the same address (e.g. the landlord's void account and the tenant's)
//   - the same case reference: the same complaint, for certain
//   - both have a postcode: the property decides (same flat/house = same)
//   - only one has an address: not assumed the same
//   - neither has an address or an account number: raised within a fortnight
//     is a POSSIBLE match, never a certain one
// The words that name a street or building in an address ("moorfields",
// "falkner", "waverley"), leaving out the kind of place, towns and filler.
const NOT_A_NAME = new Set(['apartment', 'apartments', 'flat', 'flats', 'unit', 'suite', 'room', 'floor', 'block', 'house',
  'road', 'street', 'lane', 'avenue', 'close', 'crescent', 'drive', 'place', 'court', 'way', 'grove', 'gardens',
  'terrace', 'square', 'walk', 'mews', 'view', 'building', 'liverpool', 'manchester', 'salford', 'merseyside',
  'lancashire', 'greater', 'bootle', 'the', 'and', 'of', 'at']);
const nameWords = (text) => new Set(String(text || '').toLowerCase()
  .replace(/\b[a-z]{1,2}\d[a-z\d]?\s*\d[a-z]{2}\b/g, ' ') // the postcode
  .split(/[^a-z]+/).filter((w) => w.length >= 4 && !NOT_A_NAME.has(w)));

// Two addresses, at least one without a postcode, written out the same:
// the same flat/house numbers and a street or building name in common
// ("Apartment 326, 2 Moorfields" and "Apt 326, 2 Moorfields, Liverpool L2 2BT").
export function sameAddressText(pa, pb) {
  const a = addressNumbers(pa);
  const b = addressNumbers(pb);
  if (!a.size || !b.size) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (![...small].every((n) => big.has(n))) return false;
  const wa = nameWords(pa);
  const wb = nameWords(pb);
  return [...wa].some((w) => wb.has(w));
}

// The same account number on both, however it was filed (as an account
// number on one, "their reference" on the other). The account number is the
// key: one account, one complaint.
export function sameAccount(a, b) {
  const aa = accountsOf(a); const ab = accountsOf(b);
  const ra = refNumbersOf(a); const rb = refNumbersOf(b);
  const long = (v) => v.length >= 6;
  return [...aa].some((v) => long(v) && (ab.has(v) || rb.has(v))) || [...ab].some((v) => long(v) && ra.has(v));
}

export function issueMatch(a, b) {
  const no = { same: false, certain: false };
  const aa = accountsOf(a);
  const ab = accountsOf(b);
  // The same account number is the same complaint whoever the email is from:
  // a debt collector or solicitor chasing the bill (LCS for British Gas)
  // quotes the supplier's account number under its own name.
  if ([...aa].some((v) => v.length >= 6 && ab.has(v))) return { same: true, certain: true };
  // The same number filed as an account number on one and as "their
  // reference" on the other (an import did that with A34025850): the same
  // account, so the same complaint, whichever organisation it is against.
  const ra = refNumbersOf(a);
  const rb = refNumbersOf(b);
  if ([...aa].some((v) => v.length >= 6 && rb.has(v)) || [...ab].some((v) => v.length >= 6 && ra.has(v))) {
    return { same: true, certain: true };
  }
  if (!a?.org_name || !b?.org_name || !sameOrgName(a.org_name, b.org_name)) return no;
  if (shares(aa, ab)) return { same: true, certain: true };
  if (aa.size && ab.size) return no;
  if (shares(refsOf(a), refsOf(b))) return { same: true, certain: true };
  const pa = postcodeOf(a.property);
  const pb = postcodeOf(b.property);
  if (pa && pb) {
    const same = sameProperty(a.property, b.property);
    return { same, certain: same };
  }
  // One or neither has a postcode: the address as written can still settle it.
  if (a.property && b.property && sameAddressText(a.property, b.property)) return { same: true, certain: true };
  if (pa || pb) return no;
  return nearInTime(a.raised_on, b.raised_on) ? { same: true, certain: false } : no;
}

// Two found complaints are the same issue (see issueMatch).
export function sameIssue(a, b) {
  return issueMatch(a, b).same;
}

// Is a found past complaint one already in the system? A complaint counts as
// the same organisation by its own name or its linked organisation's. A
// certain match (same account number, or same property) is preferred over a
// possible one. Returns the matching complaint, or null.
export function findExistingComplaint(complaints, orgs, x) {
  return findExistingMatch(complaints, orgs, x)?.complaint || null;
}

export function findExistingMatch(complaints, orgs, x) {
  if (!x) return null;
  let possible = null;
  for (const c of complaints) {
    const org = c.organisation_id ? orgs.find((o) => o.id === c.organisation_id) : null;
    // Every organisation on it: a complaint against British Gas that also
    // has LCS on it is found from an LCS letter too (migration 029).
    const names = [c.org_name, org?.name, ...(c.party_names || [])].filter(Boolean);
    const name = x.org_name ? names.find((n) => sameOrgName(n, x.org_name)) : null;
    // Without the same organisation only the account number can match.
    const m = issueMatch({ ...c, org_name: name || c.org_name }, name ? x : { ...x, org_name: null });
    if (m.certain) return { complaint: c, certain: true };
    if (m.same && !possible) possible = { complaint: c, certain: false };
  }
  return possible;
}

// Group found threads by issue (connected: if A~B and B~C, all three are one).
// Returns arrays of candidates, each group oldest first.
const when = (c) => c.extracted?.raised_on || (c.first_at ? new Date(c.first_at).toISOString().slice(0, 10) : '');

// Group found threads by issue, oldest first. A thread joins a group only if
// it is the same issue as a member AND no member has a different property
// postcode or flat number — so a thread with no postcode can't bridge two
// properties into one complaint.
// Two records that can't be the same complaint: different account numbers,
// or two different properties (unless they share an account number).
function conflicts(a, b) {
  const aa = accountsOf(a);
  const ab = accountsOf(b);
  if (shares(aa, ab)) return false;
  if (aa.size && ab.size) return true;
  return Boolean(postcodeOf(a?.property) && postcodeOf(b?.property) && !sameProperty(a.property, b.property));
}

export function groupCandidates(cands) {
  const groups = [];
  for (const c of [...cands].sort((a, b) => when(a).localeCompare(when(b)))) {
    const g = groups.find((grp) =>
      grp.some((m) => sameIssue(m.extracted, c.extracted)) &&
      grp.every((m) => !conflicts(m.extracted, c.extracted)));
    if (g) g.push(c);
    else groups.push([c]);
  }
  return groups;
}

const STAGE_ORDER = { stage_1: 1, stage_2: 2, ombudsman: 3 };
const earliest = (vals) => vals.filter(Boolean).sort()[0] || null;

// One complaint's details from several threads about it: raised on the
// earliest date, at the furthest stage any thread reached, and open or
// resolved as the most recent thread says.
export function mergeExtracted(group) {
  const xs = group.map((c) => c.extracted || {});
  const latest = [...group].sort((a, b) => new Date(b.last_at) - new Date(a.last_at))[0]?.extracted || xs[0];
  const furthest = xs.reduce((m, x) => ((STAGE_ORDER[x.stage] || 1) > (STAGE_ORDER[m.stage] || 1) ? x : m), xs[0]);
  return {
    ...xs[0],
    raised_on: earliest(xs.map((x) => x.raised_on)),
    acknowledged_on: earliest(xs.map((x) => x.acknowledged_on)),
    stage: furthest.stage || 'stage_1',
    responded_on: furthest.responded_on || null,
    reference: xs.map((x) => x.reference).find(Boolean) || null,
    account_numbers: [...new Set(xs.flatMap((x) => (Array.isArray(x.account_numbers) ? x.account_numbers : [])))],
    property: xs.map((x) => x.property).find((p) => postcodeOf(p)) || xs[0].property || null,
    state: latest.state || 'open',
    resolved_on: latest.state === 'resolved' ? latest.resolved_on || null : null,
    summary: group.length > 1
      ? [xs[0].summary, latest !== xs[0] ? latest.summary : null].filter(Boolean).join(' Later: ')
      : xs[0].summary,
  };
}
