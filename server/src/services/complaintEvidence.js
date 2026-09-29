import { ukDate, trackOpen } from './complaintRules.js';
import { trackKey } from './trackContact.js';

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

// `emails`: [{ id, subject, ours, on (UK day), keys (tracks it counts for) }]
// `forwardTo`: the complaint's own address.
export function evidenceChecklist({ complaint, parties = [], emails = [], docs = [], events = [], forwardTo = '', today }) {
  const fwd = forwardTo ? `forward it to ${forwardTo}` : 'forward it to the complaint’s address';
  const tracks = [complaint, ...parties].map((row, i) => ({ row, key: i === 0 ? 'main' : trackKey(row) }));
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

  const calls = events.filter((e) => CALL.test(e.note || '') && !/^Automatic|^Import/.test(e.created_by || ''));
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
    const mine = emails.filter((e) => (e.keys || []).includes(key));
    const ours = mine.filter((e) => e.ours);
    const theirs = mine.filter((e) => !e.ours);
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

    // Their answer, or the record that it never came.
    const answeredOn = row.final_response_on || row.responded_on;
    const label = row.final_response_on || row.stage === 'stage_2' ? 'Their final response' : 'Their response';
    if (answeredOn) {
      const copy = theirs.find((e) => within(e.on, answeredOn, 3, 5));
      items.push(copy
        ? { key: 'response', label, state: 'ok', detail: `Their email of ${ukDate(copy.on)}: “${copy.subject || '(no subject)'}”` }
        : { key: 'response', label, state: 'missing', fix: `Their response of ${ukDate(answeredOn)} isn't on file: ${fwd}, or upload the letter.` });
    } else if (row.response_due && row.response_due < today) {
      items.push({ key: 'response', label, state: 'ok', detail: `none came by ${ukDate(row.response_due)}, the date it was due (the missed deadline is on record here)` });
    } else {
      items.push({ key: 'response', label, state: 'na', detail: row.response_due ? `Not due yet (${ukDate(row.response_due)})` : 'Not due yet' });
    }

    // Our Stage 2 request.
    if (row.stage === 'stage_2') {
      const asked = ours.find((e) => within(e.on, row.stage_started_on, 3, 3));
      items.push(asked
        ? { key: 'stage2', label: 'Our Stage 2 request', state: 'ok', detail: `Our email of ${ukDate(asked.on)}: “${asked.subject || '(no subject)'}”` }
        : { key: 'stage2', label: 'Our Stage 2 request', state: 'missing', fix: `No copy of the Stage 2 request of ${ukDate(row.stage_started_on)}: ${fwd}.` });
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
