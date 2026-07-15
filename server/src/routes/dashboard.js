import { Router } from 'express';
import { query } from '../db/pool.js';
import { asyncHandler } from '../lib/http.js';
import {
  sendReminderEmail,
  buildDigest,
  mailerStatus,
} from '../services/mailer.js';

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

router.get(
  '/',
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
  asyncHandler(async (req, res) => {
    const days = Number(req.body?.days) || 14;
    const items = await collectDueItems(days);
    const digest = buildDigest(items);
    const result = await sendReminderEmail(digest);
    res.json({ items: items.length, ...result });
  }),
);

export default router;
