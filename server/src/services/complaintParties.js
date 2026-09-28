import { sameOrgName } from './orgMatch.js';
import { trackOpen } from './complaintRules.js';

// ---------------------------------------------------------------------------
// One complaint, more than one organisation (migration 029).
//
// A debt collector chasing a supplier's bill — LCS for British Gas — is ONE
// issue: the same property, the same account number, the same emails, and an
// update from one nearly always changes things with the other. But each
// organisation runs its own complaints procedure, with its own reference and
// its own clock. So the complaint is one record with a TRACK per organisation:
//   - the main organisation's track is the complaint row itself (unchanged
//     for every complaint that has only one);
//   - each further organisation is a complaint_parties row with the same
//     procedure fields, read by the same rules engine.
// Everything here is pure, so the routes, the email processor and the tests
// all get the same answer.
// ---------------------------------------------------------------------------

const normRef = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function domainOf(text) {
  const m = String(text || '').toLowerCase().match(/@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/);
  return m ? m[1] : null;
}

// Every track on a complaint: the main one first, then the others in the
// order they were added. `orgs` are the saved organisations the tracks link
// to (for their full name and complaints address).
export function tracksOf(complaint, parties = [], orgs = []) {
  const byId = new Map(orgs.map((o) => [o.id, o]));
  const track = (row, party) => {
    const org = row.organisation_id ? byId.get(row.organisation_id) : null;
    return {
      party,
      row,
      name: row.org_name,
      names: [row.org_name, org?.name].filter(Boolean),
      reference: row.reference || null,
      domain: domainOf(org?.complaints_email),
    };
  };
  return [track(complaint, null), ...parties.map((p) => track(p, p))];
}

const listNames = (names) =>
  names.length <= 2 ? names.join(' or ') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;

// Which organisation's track an email from "the organisation" belongs to.
// Three signs, each only counted when it points at exactly one track:
//   their reference   the reference the email quotes is one track's
//   who wrote it      the organisation the author writes for (author_org)
//   where it came from the sender's email domain is one organisation's
//                     complaints address (never ours: a forward is from us)
// One track, however many signs agree, is certain. Signs pointing at two
// different tracks, or none at all, is not — and a wrong guess would record
// their acknowledgement against the other organisation's clock — so it is
// left for a person, saying why.
// Returns { track, certain: true } or { track: null, certain: false, reason }.
export function trackForEmail({ complaint, parties = [], orgs = [], analysis, email, ourDomain }) {
  const tracks = tracksOf(complaint, parties, orgs);
  if (tracks.length === 1) return { track: tracks[0], certain: true };
  const hits = new Set();

  const ref = normRef(analysis?.their_reference);
  if (ref.length >= 4) {
    const byRef = tracks.filter((t) => normRef(t.reference) === ref);
    if (byRef.length === 1) hits.add(byRef[0]);
  }
  if (analysis?.author_org) {
    const byName = tracks.filter((t) => t.names.some((n) => sameOrgName(n, analysis.author_org)));
    if (byName.length === 1) hits.add(byName[0]);
  }
  const ours = String(ourDomain || '').toLowerCase();
  for (const d of [domainOf(email?.sender_email), domainOf(analysis?.author)]) {
    if (!d || d === ours) continue;
    const byDomain = tracks.filter((t) => t.domain && t.domain === d);
    if (byDomain.length === 1) hits.add(byDomain[0]);
  }

  const names = tracks.map((t) => t.name);
  if (hits.size === 1) return { track: [...hits][0], certain: true };
  if (hits.size > 1) {
    return {
      track: null,
      certain: false,
      reason: `It points to more than one of the organisations (${listNames([...hits].map((t) => t.name))})`,
    };
  }
  return { track: null, certain: false, reason: `It isn’t clear whether it is from ${listNames(names)}` };
}

// Is any organisation's track on this complaint still running? The complaint
// as a whole is open exactly while one is.
export function anyTrackOpen(complaint, parties = []) {
  return [complaint, ...parties].some(trackOpen);
}

// The complaint's state once one track has changed: open while any track
// runs; otherwise resolved if any track was resolved, else closed.
export function overallState(complaint, parties = []) {
  const all = [complaint, ...parties];
  if (all.some(trackOpen)) return 'open';
  const ended = (t) => (['resolved', 'closed'].includes(t.stage) ? t.stage : t.state);
  return all.some((t) => ended(t) === 'resolved') ? 'resolved' : 'closed';
}
