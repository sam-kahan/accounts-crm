import express, { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { asyncHandler, HttpError } from '../lib/http.js';
import { readSmtp2goEvent, recordBounce } from '../services/bounces.js';

// ---------------------------------------------------------------------------
// SMTP2GO tells us when an email the CRM sent bounced (migration 030). Those
// bounces go to SMTP2GO, not to any mailbox we read, so without this an email
// sent from the complaint page that never arrived would look sent.
//
// Set up in SMTP2GO (Settings → Webhooks) with the URL
//   https://accounts.greenco.co.uk/api/webhooks/email-bounce?key=<BOUNCE_WEBHOOK_KEY>
// and the bounce and reject events. The key is compared in constant time; with
// no BOUNCE_WEBHOOK_KEY set the endpoint refuses everything. Outside
// requireAuth on its own path: the caller is a server, not a person.
// ---------------------------------------------------------------------------

const router = Router();

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

router.post(
  '/',
  express.urlencoded({ extended: true, limit: '200kb' }),
  asyncHandler(async (req, res) => {
    const key = config.bounceWebhookKey;
    const given = req.get('x-webhook-key') || req.query.key || '';
    if (!key || !given || !safeEqual(given, key)) throw new HttpError(401, 'Not authorised');
    // One event, or a batch of them.
    const events = Array.isArray(req.body) ? req.body : Array.isArray(req.body?.events) ? req.body.events : [req.body];
    let flagged = 0;
    for (const p of events.slice(0, 100)) {
      const b = readSmtp2goEvent(p);
      if (!b) continue;
      const ids = await recordBounce({
        addresses: [b.address], reason: b.reason, source: 'smtp2go',
        // Without the event's own id or time there is nothing that says two
        // events are the same one: no key, so a later bounce to the same
        // address (after someone looked into the first) is never swallowed.
        sourceRef: b.ref || ((p?.sendtime || p?.time || p?.timestamp) ? `${b.address}:${p.sendtime || p.time || p.timestamp}` : null), subject: b.subject,
      });
      flagged += ids.length;
    }
    // Always 200 for an authorised call, so SMTP2GO doesn't keep resending
    // events that simply weren't bounces.
    res.json({ ok: true, flagged });
  }),
);

export default router;
