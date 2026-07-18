import { Router } from 'express';
import { query } from '../db/pool.js';
import { asyncHandler } from '../lib/http.js';
import { requireAuth, sessionOrCronKey } from '../middleware/auth.js';
import {
  sendReminderEmail,
  buildDigest,
  mailerStatus,
} from '../services/mailer.js';
import { effectiveRule, deriveStatus } from '../services/complaintRules.js';

const router = Router();

// Collect pending key dates + open tasks that have a due date, flagged overdue,
// within `days` ahead (plus everything already overdue).
async function collectDueItems(days = 30) {
  const keyDates = (
    await query(
      `SELECT k.id, k.title, k.due_date, k.category, c.name AS company_name,
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
    const items = await collectDueItems(days);

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

    res.json({
      window_days: days,
      counts: {
        companies: Number(counts.companies),
        open_tasks: Number(counts.open_tasks),
        overdue: Number(counts.overdue_key_dates) + Number(counts.overdue_tasks),
      },
      overdue: items.filter((i) => i.overdue),
      upcoming: items.filter((i) => !i.overdue),
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
    const [dueItems, complaintItems] = await Promise.all([
      collectDueItems(days),
      collectComplaintDueItems(days),
    ]);
    const items = [...dueItems, ...complaintItems].sort((a, b) =>
      a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0,
    );
    const digest = buildDigest(items);
    const result = await sendReminderEmail(digest);
    res.json({ items: items.length, ...result });
  }),
);

export default router;
