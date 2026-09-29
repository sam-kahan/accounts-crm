import { getSetting, setSetting } from './settings.js';

// Where each mailbox's next look starts, and what to do about one email that
// can't be stored. Shared by the catch-all and the watched mailboxes.
//
// A look reads oldest first. The checkpoint moves to when the look started
// once the whole window was read, or to the last email handled when it
// wasn't (more mail than one look reads) or when an email couldn't be stored:
// never past mail that wasn't dealt with. Each look steps back an hour from
// the checkpoint (mail can land late, and storing is de-duplicated).
export const OVERLAP_MS = 3600000;

export function lookFrom(checkpoint, firstLookMs) {
  return checkpoint
    ? new Date(new Date(checkpoint).getTime() - OVERLAP_MS)
    : new Date(Date.now() - firstLookMs);
}

// The checkpoint after a look: `stoppedAt` is the email it stopped on (not
// yet dealt with), `readTo` the last one read when the window wasn't read to
// the end.
export function nextCheckpoint({ started, complete, readTo, stoppedAt }) {
  // The next look starts an hour before the checkpoint, so these put it at
  // (just before) the email to carry on from.
  if (stoppedAt) return new Date(new Date(stoppedAt).getTime() + OVERLAP_MS - 1000).toISOString();
  if (complete) return new Date(started).toISOString();
  if (readTo) return new Date(new Date(readTo).getTime() + OVERLAP_MS).toISOString();
  return null; // nothing read: stay where it was
}

// One email that can't be stored (a lasting error on that message) must not
// hold its mailbox up for ever: the look stops there and tries it again next
// time, and after three looks it is passed over, said in the check's errors.
// Returns true to pass it over now.
export const STUCK_TRIES = 3;
export async function passOverStuck(mailbox, email) {
  const stuck = (await getSetting('mail_stuck')) || {};
  const key = email.messageId || email.graphId;
  const cur = stuck[mailbox]?.id === key ? stuck[mailbox] : { id: key, tries: 0 };
  cur.tries += 1;
  if (cur.tries >= STUCK_TRIES) {
    delete stuck[mailbox];
    await setSetting('mail_stuck', stuck);
    return true;
  }
  stuck[mailbox] = cur;
  await setSetting('mail_stuck', stuck);
  return false;
}
