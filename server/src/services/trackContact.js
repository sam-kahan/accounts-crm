import { query } from '../db/pool.js';
import { tracksOf } from './complaintParties.js';
import { sameOrgName } from './orgMatch.js';

// ---------------------------------------------------------------------------
// With more than one organisation on a complaint, "when did we last write to
// them" and "when did they last write to us" are asked of EACH organisation,
// never of the complaint as a whole: a complaint sent to Liverpool City
// Council yesterday says nothing about whether CDER Group, overdue for weeks,
// has been chased. Worked out from the emails' addresses: an organisation is
// known by the domain of its complaints address. The main organisation also
// takes any other outside address (a collector writes from customercare@
// while its complaints address is somewhere else), but never one that is a
// further organisation's. Pure and tested; `contactFor` does the reading.
// ---------------------------------------------------------------------------

const addrOf = (s) => (String(s || '').match(/[^<>\s,;"']+@[^<>\s,;"']+/) || [])[0]?.toLowerCase().replace(/[.)]+$/, '') || null;
const domainOf = (s) => addrOf(s)?.split('@')[1] || null;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const trackKey = (party) => (party ? party.id : 'main');

// `emails`: { direction, sender_email, to_addresses, received_on (UK day),
//   kind (their reading), sent_on, party_id }. `events`: the 'chased' ones,
//   { event_date, party_id, note }. Returns Map(trackKey -> { lastSentOn,
//   lastTheirsOn }).
export function contactByTrack(input) {
  const { out, emails, events } = attribute(input);
  const bump = (keys, field, date) => {
    if (!date || !ISO.test(date)) return;
    for (const k of keys) {
      const cur = out.get(k);
      if (cur && (!cur[field] || date > cur[field])) cur[field] = date;
    }
  };
  for (const e of emails) bump(e.keys, e.field, e.on);
  for (const ev of events) if (!ev.emailSent) bump(ev.keys, 'lastSentOn', ev.row.event_date);
  return out;
}

// Whose correspondence each email and chaser is: the tracks it counts for.
function attribute({ complaint, parties = [], orgs = [], emails = [], events = [], ourDomain = '' }) {
  const ours = String(ourDomain || '').toLowerCase();
  const tracks = tracksOf(complaint, parties, orgs);
  const out = new Map(tracks.map((t) => [trackKey(t.party), { lastSentOn: null, lastTheirsOn: null }]));
  const byDomain = new Map();
  for (const t of tracks) if (t.domain) byDomain.set(t.domain, trackKey(t.party));
  const partyDomains = new Set(tracks.filter((t) => t.party && t.domain).map((t) => t.domain));
  const valid = new Set(out.keys());
  const senderDomainOf = (e) => domainOf(e.sender_email);
  // Ours: sent from here, or read as our own email. One of theirs forwarded
  // in by a colleague comes from our address but is read as theirs (an
  // acknowledgement, a response): it is never Greenco writing to them.
  const isOurs = (e) => e.direction === 'outbound' || e.kind === 'our_email' ||
    (ours && senderDomainOf(e) === ours && !e.kind);
  const outsideOf = (e) => (isOurs(e) ? (e.to_addresses || []).map(domainOf) : [senderDomainOf(e)])
    .filter((d) => d && d !== ours);
  // An email recorded against a further organisation teaches its address
  // (an organisation set up without a complaints address is still known by
  // the address the complaint to it went to).
  for (const e of emails) {
    if (!e.party_id || !valid.has(e.party_id)) continue;
    for (const d of outsideOf(e)) {
      if (!byDomain.has(d)) byDomain.set(d, e.party_id);
      if (byDomain.get(d) === e.party_id) partyDomains.add(d);
    }
  }

  // Which organisations a set of outside domains is. One organisation: all
  // of it is theirs. With more, an address that is none of the further
  // organisations' is the main one's.
  const keysFor = (domains, partyId) => {
    const outside = domains.filter((d) => d && d !== ours);
    if (!parties.length) return outside.length ? ['main'] : [];
    if (partyId && valid.has(partyId)) return [partyId];
    const hits = new Set(outside.map((d) => byDomain.get(d)).filter(Boolean));
    if (!hits.size && outside.some((d) => !partyDomains.has(d))) hits.add('main');
    return [...hits];
  };

  const emailRows = emails.map((e) => ({
    row: e,
    keys: keysFor(outsideOf(e), e.party_id),
    field: isOurs(e) ? 'lastSentOn' : 'lastTheirsOn',
    on: ISO.test(e.sent_on || '') ? e.sent_on : e.received_on,
    outside: outsideOf(e),
  }));
  // A chaser recorded by hand is on the organisation it was recorded
  // against. One recorded with no organisation, on a complaint that has
  // more than one, is placed by any address it names; failing that it is
  // the main organisation's only if it came before any other organisation
  // was added (before then there was no one else it could be about).
  const firstParty = parties.map((p) => p.raised_on).filter(Boolean).sort()[0] || null;
  const named = (ev) => (String(ev.note || '').match(/[^<>\s,;"'()]+@[^<>\s,;"'()]+/g) || []).map(domainOf);
  const eventRows = events.map((ev) => {
    // "Email sent: …" is the entry for an email sent from here, which is
    // counted from the email itself (and its addresses); placed here only
    // to say whose it is.
    const emailSent = /^Email sent: /.test(ev.note || '');
    let keys;
    if (ev.party_id && valid.has(ev.party_id)) keys = [ev.party_id];
    else if (!parties.length) keys = ['main'];
    // "Sent … from Outlook to <main organisation>." (the page's button on the
    // main organisation's step, which has no party to record it against).
    else if (complaint.org_name && String(ev.note || '').trim().endsWith(` to ${complaint.org_name}.`)) keys = ['main'];
    else if (named(ev).length) keys = keysFor(named(ev), null);
    else keys = !firstParty || ev.event_date < firstParty ? ['main'] : [];
    return { row: ev, keys, emailSent };
  });
  const domainsOf = (key) => [...byDomain].filter(([, k]) => k === key).map(([d]) => d);
  return { out, emails: emailRows, events: eventRows, domainsOf };
}

// Big free mail services: never "an organisation's address".
const PUBLIC_MAIL = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|mac|aol|btinternet|sky|virginmedia|talktalk|protonmail|proton|gmx|mail)\.[a-z.]+$/;

// Taking one organisation (`removeKey`: 'main' or a party id) off a
// complaint: which emails and chasers are its history, and the addresses it
// writes from. Tagged exactly as they are counted now, so what the
// remaining organisations' "last wrote / last heard" says is unchanged by
// the removal: an email or chaser that counts for a remaining organisation
// stays theirs; one that counts only for the removed organisation (or, the
// main one being taken off, for no one) is tagged — unless it is certainly a
// remaining organisation's (the AI read it as written by one, or it went
// only to their addresses). An address that is a remaining organisation's is
// never remembered as the removed one's, and only an email to or from the
// removed organisation ALONE teaches its address (never a copied-in one).
// Emails carry `author_org` (their reading) for this. Pure and tested.
export function removalTags(input, removeKey) {
  const { emails, events } = attribute(input);
  const stays = (keys) => keys.some((k) => k !== removeKey);
  const tracks = tracksOf(input.complaint, input.parties || [], input.orgs || []);
  const gone = tracks.find((t) => trackKey(t.party) === removeKey);
  const remaining = tracks.filter((t) => trackKey(t.party) !== removeKey);
  const writtenByRemaining = (e) => Boolean(e.row.author_org) &&
    remaining.some((t) => t.names.some((n) => sameOrgName(n, e.row.author_org)));
  // Certainly a remaining organisation's addresses.
  const keptSure = new Set(remaining.map((t) => t.domain).filter(Boolean));
  for (const e of emails) {
    const forRemaining = e.row.party_id && e.row.party_id !== removeKey && remaining.some((t) => t.party?.id === e.row.party_id);
    if (writtenByRemaining(e) || forRemaining) for (const d of e.outside) keptSure.add(d);
  }
  // Also any address on an email that counts for a remaining organisation.
  const kept = new Set(keptSure);
  for (const e of emails) if (stays(e.keys)) for (const d of e.outside) kept.add(d);

  const tagged = emails.filter((e) => e.keys.length && !stays(e.keys) && !writtenByRemaining(e) &&
    !(e.outside.length && e.outside.every((d) => keptSure.has(d))));
  const eventIds = events
    .filter((ev) => (removeKey === 'main' ? !stays(ev.keys) : ev.keys.length && !stays(ev.keys)))
    .map((ev) => ev.row.id);
  const domains = new Set(gone?.domain ? [gone.domain] : []);
  for (const e of tagged) if (e.outside.length === 1) domains.add(e.outside[0]);
  return {
    emailIds: tagged.map((e) => e.row.id),
    eventIds,
    domains: [...domains].filter((d) => d && !kept.has(d) && !PUBLIC_MAIL.test(d)),
  };
}

// For the complaints given (with their parties and organisations already
// loaded): Map(complaintId -> Map(trackKey -> contact)).
export async function contactFor(complaints, partiesOf, orgList, ourDomain) {
  const ids = complaints.map((c) => c.id);
  if (!ids.length) return new Map();
  const emails = (await query(
    `SELECT complaint_id, direction, sender_email, to_addresses, party_id,
            (received_at AT TIME ZONE 'Europe/London')::date::text AS received_on,
            analysis->>'kind' AS kind, analysis->>'sent_on' AS sent_on
       FROM complaint_emails WHERE complaint_id = ANY($1::uuid[]) AND removed_org IS NULL`,
    [ids],
  )).rows;
  const events = (await query(
    `SELECT complaint_id, party_id, event_date::text AS event_date, note
       FROM complaint_events WHERE type = 'chased' AND complaint_id = ANY($1::uuid[]) AND removed_org IS NULL`,
    [ids],
  )).rows;
  const out = new Map();
  for (const c of complaints) {
    out.set(c.id, contactByTrack({
      complaint: c,
      parties: partiesOf(c.id),
      orgs: orgList,
      emails: emails.filter((e) => e.complaint_id === c.id),
      events: events.filter((e) => e.complaint_id === c.id),
      ourDomain,
    }));
  }
  return out;
}

// Complaints raised with a supplier from here before the email recorded who
// it went to: the email sent in the same moment as the supplier was added
// (and its "Email sent" entry) is theirs. No AI; idempotent; start-up.
export async function linkSupplierEmails() {
  const r = await query(
    `UPDATE complaint_emails e SET party_id = ev.party_id
       FROM complaint_events ev
      WHERE ev.type = 'raised' AND ev.party_id IS NOT NULL AND ev.note LIKE '%, sent from here.'
        AND e.complaint_id = ev.complaint_id AND e.direction = 'outbound' AND e.party_id IS NULL
        AND e.received_at BETWEEN ev.created_at - interval '5 minutes' AND ev.created_at
     RETURNING e.id, e.complaint_id, e.subject, ev.party_id, (e.received_at AT TIME ZONE 'Europe/London')::date::text AS on`,
  );
  for (const e of r.rows) {
    await query(
      `UPDATE complaint_events SET party_id = $2
        WHERE complaint_id = $1 AND type = 'chased' AND party_id IS NULL AND event_date = $3::date
          AND left(note, length('Email sent: ' || $4 || ', to ')) = 'Email sent: ' || $4 || ', to '`,
      [e.complaint_id, e.party_id, e.on, e.subject || '(no subject)'],
    );
  }
  return r.rowCount;
}

// One complaint's contact per organisation, read from scratch.
export async function contactForOne(complaintId, ourDomain) {
  const c = (await query('SELECT * FROM complaints WHERE id = $1', [complaintId])).rows[0];
  if (!c) return new Map();
  const parties = (await query('SELECT * FROM complaint_parties WHERE complaint_id = $1 ORDER BY created_at', [complaintId])).rows;
  const ids = [c, ...parties].map((t) => t.organisation_id).filter(Boolean);
  const orgs = ids.length
    ? (await query('SELECT id, name, complaints_email FROM organisations WHERE id = ANY($1::uuid[])', [ids])).rows
    : [];
  return (await contactFor([c], () => parties, orgs, ourDomain)).get(c.id) || new Map();
}

// Whose each email is (the same rule as "last wrote / last heard"): for the
// evidence checklist. Map(emailId -> { keys, ours, on }).
export function emailTracks(input) {
  const { emails } = attribute(input);
  return new Map(emails.map((e) => [e.row.id, { keys: e.keys, ours: e.field === 'lastSentOn', on: e.on }]));
}
