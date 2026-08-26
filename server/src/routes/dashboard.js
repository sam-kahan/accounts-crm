import { Router } from 'express';
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
import { effectiveRule, deriveStatus } from '../services/complaintRules.js';
import { syncAllCompanies } from '../services/companySync.js';
import { syncInvoicing } from '../services/invoicingSync.js';
import { withNumbers } from '../lib/money.js';

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

// Collect open complaints whose response is overdue or falls due within `days`,
// as digest items. Uses the rules engine to derive live status so a missed
// statutory deadline shows up as OVERDUE in the reminder.
async function collectComplaintDueItems(days = 30) {
  const { rows } = await query(
    `SELECT c.*, o.type AS org_type_override,
            o.stage1_response_days, o.stage2_response_days, o.ack_days,
            o.ombudsman_name, o.ombudsman_url, o.ombudsman_referral_months, o.legal_basis
       FROM complaints c
       LEFT JOIN organisations o ON o.id = c.organisation_id
      WHERE c.state = 'open' AND c.response_due IS NOT NULL
        AND c.response_due <= CURRENT_DATE + ($1 || ' days')::interval`,
    [days],
  );

  const items = [];
  for (const c of rows) {
    const org = c.organisation_id
      ? {
          type: c.org_type_override,
          stage1_response_days: c.stage1_response_days,
          stage2_response_days: c.stage2_response_days,
          ack_days: c.ack_days,
          ombudsman_name: c.ombudsman_name,
          ombudsman_url: c.ombudsman_url,
          ombudsman_referral_months: c.ombudsman_referral_months,
          legal_basis: c.legal_basis,
        }
      : null;
    const rule = effectiveRule(org, c.org_type);
    const { status, overdue } = deriveStatus(c, rule);
    if (status === 'responded' || status === 'resolved') continue; // already handled
    items.push({
      type: 'complaint',
      id: c.id,
      label: `Complaint ${overdue ? 'response OVERDUE' : 'response due'} — ${c.subject}`,
      due_date: c.response_due,
      company_name: c.org_name,
      overdue,
    });
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

    res.json({
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
      if (invoicing?.pushes?.sent || invoicing?.refreshes?.changed) {
        console.log(
          `[reminders] invoicing: ${invoicing.pushes.sent} pushed, ${invoicing.refreshes.changed} updated`,
        );
      }
    } catch (err) {
      console.error('[reminders] invoicing sync failed:', err.message);
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
    res.json({ items: items.length, sync, invoicing, ...result });
  }),
);

export default router;
