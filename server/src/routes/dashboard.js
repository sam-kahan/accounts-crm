import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { asyncHandler } from '../lib/http.js';
import { requireAuth, sessionOrCronKey } from '../middleware/auth.js';
import { can } from '../services/permissions.js';
import {
  sendReminderEmail,
  buildDigest,
  mailerStatus,
} from '../services/mailer.js';
import { carriedLineSql } from '../services/commission.js';
import { decorateMany } from '../services/complaintContext.js';
import { syncAllCompanies } from '../services/companySync.js';
import { syncInvoicing } from '../services/invoicingSync.js';
import { refreshStaleReviews } from '../services/complaintReview.js';
import { withNumbers } from '../lib/money.js';
import { todayISO, addDays } from '../lib/dates.js';
import { plural } from '../lib/words.js';
import { theOmbudsman, ukDate } from '../services/complaintRules.js';

const router = Router();

// Companies whose dates are still reminded. Once a company is dissolved, in
// liquidation, administration or receivership, or closed, the office holder
// files (or nothing is filed) and Companies House stops moving its dates on,
// so they would read as overdue every morning for ever. A voluntary
// arrangement keeps trading and filing, so it stays.
const STOPPED = ['dissolved', 'liquidation', 'administration', 'receivership', 'insolvency-proceedings',
  'converted-closed', 'closed', 'removed'];
const REMINDED_COMPANY = `COALESCE(c.status, 'active') NOT IN (${STOPPED.map((x) => `'${x}'`).join(', ')})`;
// When a key date is actually late. A confirmation statement is reminded on
// the date it is made up to (it can be filed from then), but the legal
// deadline is 14 days later: overdue only after that.
const KEY_DEADLINE = `(CASE WHEN k.category = 'confirmation_statement' AND k.source = 'companies_house'
    AND c.confirmation_statement_next_due >= k.due_date
  THEN c.confirmation_statement_next_due ELSE k.due_date END)`;

// Collect pending key dates + open tasks that have a due date, flagged overdue,
// within `days` ahead (plus everything already overdue).
async function collectDueItems(days = 30) {
  const keyDates = (
    await query(
      `SELECT k.id, k.title, k.due_date, k.category, k.source, k.recurrence,
              c.name AS company_name,
              ${KEY_DEADLINE} AS deadline,
              (${KEY_DEADLINE} < $2::date) AS overdue
         FROM key_dates k JOIN companies c ON c.id = k.company_id
        WHERE k.status = 'pending'
          AND ${REMINDED_COMPANY}
          AND k.due_date <= $2::date + ($1 || ' days')::interval
        ORDER BY k.due_date ASC`,
      // Today in the UK, not the database server's clock.
      [days, todayISO()],
    )
  ).rows.map((r) => ({
    type: 'key_date',
    id: r.id,
    // Ready to file but not yet late (a confirmation statement between its
    // date and its deadline) says so, rather than "overdue".
    label: !r.overdue && r.deadline !== r.due_date && r.due_date <= todayISO()
      ? `${r.title} (ready to file; the deadline is ${ukDate(r.deadline)})`
      : r.title,
    deadline: r.deadline,
    due_date: r.due_date,
    category: r.category,
    source: r.source,
    recurrence: r.recurrence,
    company_name: r.company_name,
    overdue: r.overdue,
  }));

  const tasks = (
    await query(
      `SELECT t.id, t.title, t.due_date, t.priority, c.name AS company_name,
              (t.due_date < $2::date) AS overdue
         FROM tasks t LEFT JOIN companies c ON c.id = t.company_id
        WHERE t.status <> 'done' AND t.due_date IS NOT NULL
          AND t.due_date <= $2::date + ($1 || ' days')::interval
        ORDER BY t.due_date ASC`,
      [days, todayISO()],
    )
  ).rows.map((r) => ({
    type: 'task',
    id: r.id,
    label: r.title,
    due_date: r.due_date,
    priority: r.priority,
    company_name: r.company_name,
    overdue: r.overdue,
  }));

  return [...keyDates, ...tasks].sort((a, b) =>
    a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0,
  );
}

// Collect open complaints whose response is overdue or falls due within `days`
// — plus any not acknowledged in time — as digest items. Uses the rules engine
// to derive live status so a missed deadline shows up as OVERDUE in the reminder.
export async function collectComplaintDueItems(days = 30) {
  const { rows } = await query(
    `SELECT * FROM complaints WHERE state = 'open'`,
  );
  const horizon = addDays(todayISO(), days);

  // Each organisation on a complaint is due on its own procedure (migration
  // 029), so each gets its own line, named for that organisation.
  const decorated = await decorateMany(rows);
  const items = [];
  for (const c of decorated) {
    // What to do about it, and a link straight to it: the AI's next step when
    // its review is up to date, otherwise the one worked out from the dates.
    const aiStep = (c.ai_review_current && (c.ai_review?.headline || c.ai_review?.recommended_action)) || null;
    const link = `${config.appUrl.replace(/\/+$/, '')}/complaints/${c.id}`;
    // An email says it has been put right: confirm it (top of the list).
    if (c.resolution_suggested) {
      const r = c.resolution_suggested;
      items.push({
        type: 'complaint', id: c.id,
        label: `Complaint LOOKS RESOLVED${r.org_name ? ` (${r.org_name})` : ''}: ${c.subject}`,
        due_date: r.on || todayISO(), company_name: r.org_name || c.org_name, overdue: true,
        detail: `${r.outcome || 'An email says it has been put right'}. Confirm it on the complaint.`,
        link,
      });
    }
    const multi = (c.parties || []).length > 0;
    for (const [i, t] of [c, ...(c.parties || [])].entries()) {
      // Each organisation's own step (the review gives one per organisation
      // when there is more than one), never another organisation's.
      const aiOwn = multi ? (c.track_review_current?.[i] ? c.ai_review?.by_org?.[i]?.headline : null) : (c.ai_review_current ? aiStep : null);
      const detail = aiOwn || t.nextAction || null;
      // (Whose it is is company_name, shown after the label: never twice.)
      // The last day to refer to the ombudsman: after it the complaint can't
      // go there at all, so it is listed whatever else the track is waiting
      // for (a final response in hand, for one, leaves nothing else due).
      if (!['with_ombudsman', 'resolved', 'closed', 'not_sent'].includes(t.status) && t.ombudsman_deadline && t.ombudsman_deadline <= horizon) {
        const passed = t.ombudsman_deadline < todayISO();
        items.push({
          type: 'complaint', id: c.id,
          label: `Complaint ${passed ? 'REFER-BY DATE PASSED' : 'last day to refer to the ombudsman'}: ${c.subject}`,
          due_date: t.ombudsman_deadline, company_name: t.org_name, overdue: passed,
          detail: passed
            ? `The time to refer it to ${theOmbudsman(t.rule?.ombudsman)} ended on ${ukDate(t.ombudsman_deadline)}. Check with them whether they will still take it.`
            : `The last day ${theOmbudsman(t.rule?.ombudsman)} will take it is ${ukDate(t.ombudsman_deadline)}. ${detail || ''}`.trim(),
          link,
        });
      }
      // Nothing due from them: responded, with the ombudsman, or finished.
      // Not sent to them yet: listed so it isn't forgotten, never as overdue.
      if (t.status === 'not_sent') {
        items.push({
          type: 'complaint', id: c.id,
          label: `Complaint NOT SENT YET: ${c.subject}`,
          due_date: todayISO(), company_name: t.org_name, overdue: false, detail: t.nextAction, link,
        });
        continue;
      }
      // Something for Greenco to do now (the organisation asked us for
      // documents or information, or the step is an email to send): listed
      // with the things to do today, whatever the dates say, since nothing
      // is overdue from them while they wait on us. What they asked for and
      // isn't on file is named, so the person knows to find it. (An overdue
      // part keeps its own OVERDUE line below, with this step as its detail.)
      if (t.action_now && (aiOwn || t.action_why) && !t.needs_chasing) {
        const what = t.action_why || aiOwn;
        const missing = (t.asked_for || []).filter((x) => !x.attachment_id && !x.given && !x.not_ours).map((x) => x.item);
        items.push({
          type: 'complaint', id: c.id,
          label: `Complaint ACTION NEEDED: ${c.subject}`,
          due_date: todayISO(), company_name: t.org_name, overdue: true,
          detail: missing.length ? `${what} Not on file yet: ${missing.join(', ')}.` : what,
          link,
        });
        continue;
      }
      if (['responded', 'with_ombudsman', 'resolved', 'closed'].includes(t.status)) continue;
      // Overdue, but Greenco has just written to them: nothing to do until
      // the hold ends, so it is listed as coming up on that day, never as
      // overdue beside a step that says to wait (chase_held_until).
      if (t.chase_held_until) {
        if (t.chase_held_until > horizon) continue;
        items.push({
          type: 'complaint', id: c.id,
          label: `Complaint: chased, waiting for their reply: ${c.subject}`,
          due_date: t.chase_held_until, company_name: t.org_name, overdue: false, detail, link,
        });
        continue;
      }
      if (t.status === 'ack_overdue') {
        items.push({
          type: 'complaint',
          id: c.id,
          label: `Complaint NOT ACKNOWLEDGED: ${c.subject}`,
          due_date: t.ack_due,
          company_name: t.org_name,
          overdue: true,
          detail,
          link,
        });
        continue;
      }
      // Not acknowledged yet, and that is due first: listed on the day the
      // acknowledgement is due (what its next step says to wait for).
      if (t.status === 'awaiting_ack' && t.ack_due && (!t.response_due || t.ack_due < t.response_due)) {
        if (t.ack_due > horizon) continue;
        items.push({
          type: 'complaint', id: c.id,
          label: `Complaint acknowledgement due: ${c.subject}`,
          due_date: t.ack_due, company_name: t.org_name, overdue: false, detail, link,
        });
        continue;
      }
      if (!t.response_due || t.response_due > horizon) continue;
      items.push({
        type: 'complaint',
        id: c.id,
        label: `Complaint ${t.overdue ? 'response OVERDUE' : 'response due'}: ${c.subject}`,
        due_date: t.response_due,
        company_name: t.org_name,
        overdue: t.overdue,
        detail,
        link,
      });
    }
  }
  return items;
}

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const days = Number(req.query.days) || 30;
    // The dashboard summarises other sections, so it shows only the ones this
    // user may see — otherwise it would leak the very figures their access was
    // meant to withhold.
    const seeCompanies = can(req.user, 'companies');
    const seeTasks = can(req.user, 'tasks');
    const seeCommission = can(req.user, 'commission');
    const seeComplaints = can(req.user, 'complaints');
    // The same list the morning email sends: key dates and tasks, and (for
    // someone who may see complaints) each complaint's deadline with its next
    // step, in date order. Without the complaints, "Nothing overdue" sat
    // beside complaints weeks overdue.
    const items = [
      ...(await collectDueItems(days)).filter((i) => (i.type === 'task' ? seeTasks : seeCompanies)),
      ...(seeComplaints ? await collectComplaintDueItems(days) : []),
    ].sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));

    const counts = (
      await query(`
        SELECT
          (SELECT count(*) FROM companies) AS companies,
          (SELECT count(*) FROM tasks WHERE status <> 'done') AS open_tasks,
          (SELECT count(*) FROM key_dates k JOIN companies c ON c.id = k.company_id
             WHERE k.status = 'pending' AND ${KEY_DEADLINE} < $1::date AND ${REMINDED_COMPANY}) AS overdue_key_dates,
          (SELECT count(*) FROM tasks
             WHERE status <> 'done' AND due_date < $1::date) AS overdue_tasks
      `, [todayISO()])
    ).rows[0];

    // Contractor commission at a glance: what is waiting to be invoiced, and
    // what has been invoiced but not yet paid back to us.
    const commission = !seeCommission ? null : (
      await query(`
        SELECT
          (SELECT COALESCE(sum(commission_amount), 0) FROM contractor_invoices
             WHERE commission_invoice_id IS NULL AND NOT waived)      AS pending_commission,
          (SELECT count(*) FROM contractor_invoices
             WHERE commission_invoice_id IS NULL AND NOT waived)      AS pending_count,
          -- Commission still to invoice from BEFORE this month: month end is
          -- worked a month at a time, so one that was never raised would
          -- otherwise just stop being looked at. A line whose own month WAS
          -- invoiced doesn't count — it arrived late and is carried onto the
          -- next invoice, so there is nothing to chase.
          (SELECT COALESCE(sum(i.commission_amount), 0) FROM contractor_invoices i
             WHERE i.commission_invoice_id IS NULL AND NOT i.waived
               AND i.invoice_date < date_trunc('month', $1::date)
               AND NOT ${carriedLineSql('i')})                        AS earlier_commission,
          (SELECT count(DISTINCT to_char(i.invoice_date, 'YYYY-MM')) FROM contractor_invoices i
             WHERE i.commission_invoice_id IS NULL AND NOT i.waived
               AND i.invoice_date < date_trunc('month', $1::date)
               AND NOT ${carriedLineSql('i')})                        AS earlier_months,
          (SELECT COALESCE(sum(commission_amount), 0) FROM contractor_invoices
             WHERE invoice_date >= date_trunc('month', $1::date)) AS month_commission,
          (SELECT COALESCE(sum(total_amount), 0) FROM commission_invoices
             WHERE status = 'sent')                                   AS awaiting_payment,
          (SELECT count(*) FROM commission_invoices
             WHERE status = 'sent')                                   AS awaiting_count
      `, [todayISO()])
    ).rows[0];

    // Complaints at a glance: open, and how many need chasing or have an
    // email waiting for a person — worked out by the same rules as the page.
    let complaints = null;
    if (seeComplaints) {
      const { rows } = await query(
        `SELECT * FROM complaints WHERE state = 'open'`,
      );
      const decorated = await decorateMany(rows);
      // Overdue and not just written to (chase_now): the same rule the next
      // step uses, so the tile never counts one whose step is to wait.
      const chasing = decorated.filter((c) => c.any_chase_now).length;
      // A step to take now that isn't a chase (they asked us for documents,
      // say): counted once, never as well as "needs chasing".
      const action = decorated.filter((c) => c.any_action_now && !c.any_chase_now).length;
      // Against an organisation whose own procedure hasn't been researched
      // (usually set up by an import): its dates are only the standard ones.
      const unresearched = decorated.filter((c) => c.unresearched_orgs.length).length;
      const waiting = (
        await query(
          `SELECT count(*)::int AS n FROM complaint_emails
            WHERE direction <> 'outbound' AND reviewed_at IS NULL`,
        )
      ).rows[0].n;
      const toCheck = (await query('SELECT count(*)::int AS n FROM complaints WHERE needs_check')).rows[0].n;
      const bounced = (await query('SELECT count(*)::int AS n FROM email_bounces WHERE resolved_at IS NULL')).rows[0].n;
      const looksResolved = rows.filter((c) => c.resolution_suggested).length;
      complaints = { open: rows.length, chasing, action, waiting, to_check: toCheck, bounced, looks_resolved: looksResolved, unresearched };
    }

    res.json({
      complaints,
      window_days: days,
      // Only the figures of sections this viewer may see (null: not shown).
      counts: {
        companies: seeCompanies ? Number(counts.companies) : null,
        open_tasks: seeTasks ? Number(counts.open_tasks) : null,
        overdue: seeCompanies || seeTasks || seeComplaints
          ? (seeCompanies ? Number(counts.overdue_key_dates) : 0) + (seeTasks ? Number(counts.overdue_tasks) : 0) +
            items.filter((i) => i.type === 'complaint' && i.overdue).length
          : null,
      },
      overdue: items.filter((i) => i.overdue),
      upcoming: items.filter((i) => !i.overdue),
      commission: commission
        ? {
            ...withNumbers(commission, [
              'pending_commission',
              'month_commission',
              'awaiting_payment',
              'earlier_commission',
            ]),
            pending_count: Number(commission.pending_count),
            earlier_months: Number(commission.earlier_months),
            awaiting_count: Number(commission.awaiting_count),
          }
        : null,
      mailer: mailerStatus(),
    });
  }),
);

// The morning run: refresh Companies House, put the invoicing systems in
// step, refresh stale AI reviews, then email the digest. It takes minutes
// (well past nginx's 60 seconds), so it runs in the background: the request
// answers at once, a second run is refused while one is going (a gateway
// timeout used to invite a second press, and a second digest to everyone),
// and GET /reminders-run says how it went.
let reminderRun = null;
async function runReminders({ days, to }) {
  // Refresh statutory dates from Companies House first, so an item filed at
  // CH (accounts, confirmation statement) has already rolled forward and
  // won't be emailed as overdue. Best-effort: a CH hiccup must not stop the
  // digest going out, but the digest SAYS so, since its dates may be stale.
  const notes = [];
  let sync = null;
  try {
    sync = await syncAllCompanies();
    if (!sync.enabled) {
      notes.push('Companies House is not connected (no API key on the server), so company dates were not refreshed.');
    } else if (sync.failed) {
      console.warn(`[reminders] Companies House sync: ${sync.synced}/${sync.total} ok, ${sync.failed} failed`);
      notes.push(`Companies House: the dates of ${plural(sync.failed, 'company', 'companies')} of ${sync.total} could not be refreshed ` +
        `(${sync.failures[0]?.error || 'unknown error'}), so they may be out of date.`);
    }
  } catch (err) {
    console.error('[reminders] Companies House sync failed:', err.message);
    notes.push(`Companies House: company dates could not be refreshed (${err.message}), so they may be out of date.`);
  }

  // Then put the two invoicing systems back in step: re-push anything that
  // never reached Greenco Invoicing, and read back anything that could have
  // moved there without us hearing about it. Best-effort for the same reason
  // — a bridge that is down must not stop the digest going out.
  let invoicing = null;
  try {
    invoicing = await syncInvoicing();
    if (
      invoicing?.pushes?.sent ||
      invoicing?.refreshes?.changed ||
      invoicing?.withdrawals?.withdrawn
    ) {
      console.log(
        `[reminders] invoicing: ${invoicing.pushes.sent} pushed, ` +
          `${invoicing.withdrawals.withdrawn} withdrawn, ${invoicing.refreshes.changed} updated`,
      );
    }
  } catch (err) {
    console.error('[reminders] invoicing sync failed:', err.message);
  }

  // Complaints whose position the calendar has moved on overnight get a
  // fresh AI review, so the next step is waiting when someone opens them.
  let reviews = null;
  try {
    reviews = await refreshStaleReviews();
  } catch (err) {
    console.error('[reminders] complaint reviews failed:', err.message);
  }

  const [dueItems, complaintItems] = await Promise.all([
    collectDueItems(days),
    collectComplaintDueItems(days),
  ]);
  const items = [...dueItems, ...complaintItems].sort((a, b) =>
    a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0,
  );
  const digest = buildDigest(items, { notes });
  const result = await sendReminderEmail({ ...digest, to });
  return { items: items.length, sync: sync && { ...sync, failures: sync.failures?.slice(0, 5) }, invoicing, reviews, ...result };
}

router.post(
  '/send-reminders',
  // Everything the nightly job does, so administrators only by hand.
  sessionOrCronKey('admin'),
  asyncHandler(async (req, res) => {
    if (reminderRun?.status === 'running') {
      return res.status(409).json({ error: 'The reminders are already being sent. They take a minute or two.', run: reminderRun });
    }
    const days = Number(req.body?.days) || 14;
    // A person pressing the button gets the email themselves; the morning
    // run (the cron key) goes to the reminder list.
    const to = req.user?.email ? [req.user.email] : undefined;
    reminderRun = { status: 'running', started_at: new Date().toISOString(), by: req.user?.email || 'scheduled' };
    const run = reminderRun;
    runReminders({ days, to })
      .then((result) => Object.assign(run, { status: 'done', finished_at: new Date().toISOString(), result }))
      .catch((err) => {
        console.error('[reminders] run failed:', err);
        Object.assign(run, { status: 'failed', finished_at: new Date().toISOString(), error: err.message });
      });
    res.status(202).json({ started: true, run: reminderRun });
  }),
);

router.get(
  '/reminders-run',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json(reminderRun || { status: 'never' });
  }),
);

export default router;
