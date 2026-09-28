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

const router = Router();

// Collect pending key dates + open tasks that have a due date, flagged overdue,
// within `days` ahead (plus everything already overdue).
async function collectDueItems(days = 30) {
  const keyDates = (
    await query(
      `SELECT k.id, k.title, k.due_date, k.category, k.source, k.recurrence,
              c.name AS company_name,
              (k.due_date < CURRENT_DATE) AS overdue
         FROM key_dates k JOIN companies c ON c.id = k.company_id
        WHERE k.status = 'pending'
          AND k.due_date <= CURRENT_DATE + ($1 || ' days')::interval
        ORDER BY k.due_date ASC`,
      [days],
    )
  ).rows.map((r) => ({
    type: 'key_date',
    id: r.id,
    label: r.title,
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
              (t.due_date < CURRENT_DATE) AS overdue
         FROM tasks t LEFT JOIN companies c ON c.id = t.company_id
        WHERE t.status <> 'done' AND t.due_date IS NOT NULL
          AND t.due_date <= CURRENT_DATE + ($1 || ' days')::interval
        ORDER BY t.due_date ASC`,
      [days],
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
async function collectComplaintDueItems(days = 30) {
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
    const aiStep = (c.ai_review_current && c.ai_review?.recommended_action) || null;
    const link = `${config.appUrl.replace(/\/+$/, '')}/complaints/${c.id}`;
    for (const t of [c, ...(c.parties || [])]) {
      const main = t === c;
      const detail = (main ? aiStep : null) || t.nextAction || null;
      const whose = c.parties?.length ? ` (${t.org_name})` : '';
      // Nothing due from them: responded, with the ombudsman, or finished.
      if (['responded', 'with_ombudsman', 'resolved', 'closed'].includes(t.status)) continue;
      if (t.status === 'ack_overdue') {
        items.push({
          type: 'complaint',
          id: c.id,
          label: `Complaint NOT ACKNOWLEDGED${whose}: ${c.subject}`,
          due_date: t.ack_due,
          company_name: t.org_name,
          overdue: true,
          detail,
          link,
        });
        continue;
      }
      if (!t.response_due || t.response_due > horizon) continue;
      items.push({
        type: 'complaint',
        id: c.id,
        label: `Complaint ${t.overdue ? 'response OVERDUE' : 'response due'}${whose}: ${c.subject}`,
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
    const items = (await collectDueItems(days)).filter((i) =>
      i.type === 'task' ? seeTasks : seeCompanies,
    );

    const counts = (
      await query(`
        SELECT
          (SELECT count(*) FROM companies) AS companies,
          (SELECT count(*) FROM tasks WHERE status <> 'done') AS open_tasks,
          (SELECT count(*) FROM key_dates
             WHERE status = 'pending' AND due_date < CURRENT_DATE) AS overdue_key_dates,
          (SELECT count(*) FROM tasks
             WHERE status <> 'done' AND due_date < CURRENT_DATE) AS overdue_tasks
      `)
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
               AND i.invoice_date < date_trunc('month', CURRENT_DATE)
               AND NOT ${carriedLineSql('i')})                        AS earlier_commission,
          (SELECT count(DISTINCT to_char(i.invoice_date, 'YYYY-MM')) FROM contractor_invoices i
             WHERE i.commission_invoice_id IS NULL AND NOT i.waived
               AND i.invoice_date < date_trunc('month', CURRENT_DATE)
               AND NOT ${carriedLineSql('i')})                        AS earlier_months,
          (SELECT COALESCE(sum(commission_amount), 0) FROM contractor_invoices
             WHERE invoice_date >= date_trunc('month', CURRENT_DATE)) AS month_commission,
          (SELECT COALESCE(sum(total_amount), 0) FROM commission_invoices
             WHERE status = 'sent')                                   AS awaiting_payment,
          (SELECT count(*) FROM commission_invoices
             WHERE status = 'sent')                                   AS awaiting_count
      `)
    ).rows[0];

    // Complaints at a glance: open, and how many need chasing or have an
    // email waiting for a person — worked out by the same rules as the page.
    let complaints = null;
    if (seeComplaints) {
      const { rows } = await query(
        `SELECT * FROM complaints WHERE state = 'open'`,
      );
      const chasing = (await decorateMany(rows)).filter((c) => c.any_needs_chasing).length;
      const waiting = (
        await query(
          `SELECT count(*)::int AS n FROM complaint_emails
            WHERE direction <> 'outbound' AND reviewed_at IS NULL`,
        )
      ).rows[0].n;
      const toCheck = (await query('SELECT count(*)::int AS n FROM complaints WHERE needs_check')).rows[0].n;
      const bounced = (await query('SELECT count(*)::int AS n FROM email_bounces WHERE resolved_at IS NULL')).rows[0].n;
      complaints = { open: rows.length, chasing, waiting, to_check: toCheck, bounced };
    }

    res.json({
      complaints,
      window_days: days,
      counts: {
        companies: Number(counts.companies),
        open_tasks: Number(counts.open_tasks),
        overdue: Number(counts.overdue_key_dates) + Number(counts.overdue_tasks),
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

// Send the reminder digest by email (SMTP2GO). Trigger manually now; a cron/
// scheduler can hit this endpoint daily later.
router.post(
  '/send-reminders',
  sessionOrCronKey,
  asyncHandler(async (req, res) => {
    const days = Number(req.body?.days) || 14;

    // Refresh statutory dates from Companies House first, so an item filed at
    // CH (accounts, confirmation statement) has already rolled forward and
    // won't be emailed as overdue. Best-effort: a CH hiccup must not stop the
    // digest going out, so failures are swallowed after being logged.
    let sync = null;
    try {
      sync = await syncAllCompanies();
      if (sync.failed) {
        console.warn(
          `[reminders] Companies House sync: ${sync.synced}/${sync.total} ok, ${sync.failed} failed`,
        );
      }
    } catch (err) {
      console.error('[reminders] Companies House sync failed:', err.message);
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
    const digest = buildDigest(items);
    const result = await sendReminderEmail(digest);
    res.json({ items: items.length, sync, invoicing, reviews, ...result });
  }),
);

export default router;
