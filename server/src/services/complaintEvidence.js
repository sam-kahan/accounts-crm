import { ukDate, trackOpen } from './complaintRules.js';
import { trackKey } from './trackContact.js';
import { sameOrgName } from './orgMatch.js';

// ---------------------------------------------------------------------------
// What an ombudsman will want, checked while the complaint goes along rather
// than gathered from memory at the end: the account number, the complaint as
// it was made, their responses (or the record that they missed the date),
// our Stage 2 request, the emails with them, the documents behind it, calls,
// the outcome we want and what it has cost. Each item says what is on file,
// or exactly how to put right what is missing. Rules only, no AI; pure and
// tested. The ombudsman's own list (the register's what_to_include) is shown
// beside it.
//   state: 'ok' on file · 'missing' needed · 'optional' worth adding · 'na'
//   not needed (yet)
// ---------------------------------------------------------------------------

const DAY = 86400000;
const t = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const within = (d, target, before, after) => {
  if (!d || !target) return false;
  const diff = (t(d) - t(target)) / DAY;
  return diff >= -before && diff <= after;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const CALL = /\b(?:phone|phoned|call|called|calls|rang|ring|spoke|telephone|telephoned)\b/i;
// Entries the system writes (or a person's email, logged as "Email sent: …"):
// never a call someone noted.
const SYSTEM_BY = /^(?:Automatic|Import|Re-check)/i;
const SYSTEM_NOTE = /^(?:Email sent:|Details corrected|Sent\b|Automatic record|What .+ recorded)/i;

// `emails`: [{ id, subject, ours, on (UK day), keys (tracks it counts for),
//   party_id, author_org, kind }] · `events`: [{ type, party_id, event_date,
//   note, created_by }] · `forwardTo`: the complaint's own address.
export function evidenceChecklist({ complaint, parties = [], emails = [], docs = [], events = [], forwardTo = '', today }) {
  const fwd = forwardTo ? `forward it to ${forwardTo}` : 'forward it to the complaint’s address';
  const tracks = [complaint, ...parties].map((row, i) => ({ row, key: i === 0 ? 'main' : trackKey(row) }));
  // Whose an email is. By its addresses (keys) when it has an outside one;
  // an email a colleague forwarded in has only ours, so then by the part it
  // was recorded on, who wrote it (the AI's reading), or, with one
  // organisation, that one: forwarding is exactly what the checklist asks for.
  const keysOf = (e) => {
    if (e.keys?.length) return e.keys;
    if (e.party_id && tracks.some((t) => t.key === e.party_id)) return [e.party_id];
    if (e.author_org) {
      const hit = tracks.filter((t) => [t.row.org_name].filter(Boolean).some((n) => sameOrgName(n, e.author_org)));
      if (hit.length === 1) return [hit[0].key];
    }
    return tracks.length === 1 ? ['main'] : [];
  };
  const eventsOf = (key) => events.filter((e) => (key === 'main' ? !e.party_id : e.party_id === key));
  const shared = [];

  shared.push((complaint.account_numbers || []).length
    ? { key: 'account', label: 'Account number', state: 'ok', detail: complaint.account_numbers.join(', ') }
    : { key: 'account', label: 'Account number', state: 'missing', fix: 'Add the account number in Edit details: every ombudsman asks for it.' });

  const uploaded = docs.filter((d) => !d.source_email_id).length;
  const fromEmails = docs.length - uploaded;
  shared.push(docs.length
    ? {
      key: 'documents', label: 'Documents (bills, statements, letters, photos)', state: 'ok',
      detail: `${plural(docs.length, 'document')} on file` +
        (fromEmails && uploaded ? ` (${uploaded} uploaded, ${fromEmails} from emails)` : fromEmails ? ' (from emails)' : ''),
    }
    : { key: 'documents', label: 'Documents (bills, statements, letters, photos)', state: 'missing', fix: 'Upload the bills, statements or letters the complaint is about (Documents, + Upload).' });

  const calls = events.filter((e) => ['note', 'chased'].includes(e.type) && CALL.test(e.note || '') &&
    !SYSTEM_BY.test(e.created_by || '') && !SYSTEM_NOTE.test(e.note || ''));
  shared.push(calls.length
    ? { key: 'calls', label: 'Phone calls', state: 'ok', detail: `${plural(calls.length, 'call')} noted on the timeline` }
    : { key: 'calls', label: 'Phone calls', state: 'optional', fix: 'If you phoned them, note each call on the timeline: the date, the time, who you spoke to and what they said.' });

  shared.push(complaint.outcome_wanted
    ? { key: 'outcome', label: 'The outcome we want', state: 'ok', detail: complaint.outcome_wanted }
    : { key: 'outcome', label: 'The outcome we want', state: 'missing', fix: 'Say what you want them to do: correct the account, refund an amount, pay compensation, apologise.' });

  shared.push(complaint.losses
    ? { key: 'losses', label: 'Money lost or extra costs', state: 'ok', detail: complaint.losses }
    : { key: 'losses', label: 'Money lost or extra costs', state: 'optional', fix: 'If it has cost money (overcharges, fees, time spent), note the amounts and how they are worked out.' });

  const perTrack = tracks.map(({ row, key }) => {
    const mine = emails.filter((e) => keysOf(e).includes(key));
    const ours = mine.filter((e) => e.ours);
    const theirs = mine.filter((e) => !e.ours);
    const own = eventsOf(key);
    const items = [];

    // The complaint as it was made.
    const made = ours.find((e) => within(e.on, row.raised_on, 3, 3));
    if (made) {
      items.push({ key: 'complaint', label: 'The complaint we made', state: 'ok', detail: `Our email of ${ukDate(made.on)}: “${made.subject || '(no subject)'}”` });
    } else if (row.channel === 'phone') {
      items.push({ key: 'complaint', label: 'The complaint we made', state: 'optional', fix: `It was made by phone on ${ukDate(row.raised_on)}: make sure the timeline says who you spoke to and what was said. Any written confirmation should be forwarded here.` });
    } else {
      items.push({ key: 'complaint', label: 'The complaint we made', state: 'missing', fix: `No copy of the complaint made on ${ukDate(row.raised_on)}: ${fwd}, or upload the letter.` });
    }

    // Where it has got to. A Stage 2 request is known from the stage, from
    // its escalation entry, or from a final response (only Stage 2 gives one).
    const past1 = ['stage_2', 'ombudsman'].includes(row.stage) || Boolean(row.final_response_on);
    const s2Entry = own.filter((e) => e.type === 'escalated' && /stage 2/i.test(e.note || '') && !/ombudsman/i.test(e.note || ''))
      .map((e) => e.event_date).sort().pop() || null;
    const s2On = row.stage === 'stage_2' ? row.stage_started_on : s2Entry;
    const wentTo2 = row.stage === 'stage_2' || Boolean(s2Entry) || Boolean(row.final_response_on);
    const copyOf = (list, on) => list.find((e) => within(e.on, on, 3, 5));

    // Their Stage 1 response, once past Stage 1.
    if (past1) {
      const s1 = own.filter((e) => e.type === 'response_received' && /^Stage 1/i.test(e.note || '')).map((e) => e.event_date).sort().pop() || null;
      const s1Mail = theirs.find((e) => e.kind === 'stage1_response');
      if (s1) {
        const copy = copyOf(theirs, s1);
        items.push(copy
          ? { key: 'response1', label: 'Their Stage 1 response', state: 'ok', detail: `Their email of ${ukDate(copy.on)}: “${copy.subject || '(no subject)'}”` }
          : { key: 'response1', label: 'Their Stage 1 response', state: 'missing', fix: `Their Stage 1 response of ${ukDate(s1)} isn't on file: ${fwd}, or upload the letter.` });
      } else if (s1Mail) {
        items.push({ key: 'response1', label: 'Their Stage 1 response', state: 'ok', detail: `Their email of ${ukDate(s1Mail.on)}: “${s1Mail.subject || '(no subject)'}”` });
      } else {
        items.push({ key: 'response1', label: 'Their Stage 1 response', state: 'na', detail: 'none recorded (it moved on to Stage 2 without one)' });
      }
    }

    // Our Stage 2 request.
    if (wentTo2) {
      const asked = s2On ? ours.find((e) => within(e.on, s2On, 3, 3)) : null;
      items.push(asked
        ? { key: 'stage2', label: 'Our Stage 2 request', state: 'ok', detail: `Our email of ${ukDate(asked.on)}: “${asked.subject || '(no subject)'}”` }
        : { key: 'stage2', label: 'Our Stage 2 request', state: 'missing', fix: `No copy of our Stage 2 request${s2On ? ` of ${ukDate(s2On)}` : ''}: ${fwd}.` });
    }

    // Their answer at the stage it is at (their final response once past
    // Stage 1), or the record that it never came.
    const finalStage = row.stage !== 'stage_1';
    const label = finalStage || row.final_response_on ? 'Their final response' : 'Their response';
    const answeredOn = finalStage ? (row.final_response_on || (row.stage === 'stage_2' ? row.responded_on : null)) : row.responded_on;
    if (answeredOn) {
      const copy = copyOf(theirs, answeredOn);
      items.push(copy
        ? { key: 'response', label, state: 'ok', detail: `Their email of ${ukDate(copy.on)}: “${copy.subject || '(no subject)'}”` }
        : { key: 'response', label, state: 'missing', fix: `Their response of ${ukDate(answeredOn)} isn't on file: ${fwd}, or upload the letter.` });
    } else if (row.stage === 'ombudsman') {
      items.push({ key: 'response', label, state: 'ok', detail: 'none came before it was referred (the missed deadline is on the timeline)' });
    } else if (['stage_1', 'stage_2'].includes(row.stage) && row.response_due && row.response_due < today) {
      items.push({ key: 'response', label, state: 'ok', detail: `none came by ${ukDate(row.response_due)}, the date it was due (the missed deadline is on record here)` });
    } else if (['stage_1', 'stage_2'].includes(row.stage)) {
      items.push({ key: 'response', label, state: 'na', detail: row.response_due ? `Not due yet (${ukDate(row.response_due)})` : 'Not due yet' });
    } else {
      items.push({ key: 'response', label, state: 'na', detail: 'None recorded' });
    }

    items.push(mine.length
      ? { key: 'emails', label: 'Emails with them', state: 'ok', detail: `${plural(mine.length, 'email')}: ${theirs.length} from them, ${ours.length} from us` }
      : { key: 'emails', label: 'Emails with them', state: 'missing', fix: `No emails with them on file: ${fwd.replace('forward it', 'forward them')}.` });

    return { key, org_name: row.org_name, open: trackOpen(row), items };
  });

  const all = [...shared, ...perTrack.flatMap((p) => p.items)];
  return {
    shared,
    tracks: perTrack,
    missing: all.filter((i) => i.state === 'missing').length,
    ready: all.filter((i) => i.state === 'ok').length,
    needed: all.filter((i) => i.state === 'ok' || i.state === 'missing').length,
  };
}
