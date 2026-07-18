import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, HttpError, parse } from '../lib/http.js';
import { buildUpdateSet } from '../lib/sql.js';

const router = Router();

const input = z.object({
  company_id: z.string().uuid().optional().nullable(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  due_date: z.string().optional().nullable(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  status: z.enum(['todo', 'in_progress', 'done']).optional(),
});

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const conditions = [];
    const params = [];
    if (req.query.company_id) {
      params.push(req.query.company_id);
      conditions.push(`t.company_id = $${params.length}`);
    }
    if (req.query.status) {
      params.push(req.query.status);
      conditions.push(`t.status = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await query(
      `SELECT t.*, c.name AS company_name
         FROM tasks t LEFT JOIN companies c ON c.id = t.company_id
         ${where}
         ORDER BY (t.status = 'done'),
           CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
           t.due_date NULLS LAST`,
      params,
    );
    res.json(rows);
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = parse(input, req.body);
    const { rows } = await query(
      `INSERT INTO tasks (company_id, title, description, due_date, priority, status)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        data.company_id || null,
        data.title,
        data.description || null,
        data.due_date || null,
        data.priority || 'medium',
        data.status || 'todo',
      ],
    );
    res.status(201).json(rows[0]);
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = parse(input.partial(), req.body);
    // Only update the fields the caller actually sent; an explicit null clears
    // a nullable column (company_id, description, due_date) rather than being
    // ignored, while omitted fields are left untouched.
    const { clause, values } = buildUpdateSet({
      company_id: data.company_id,
      title: data.title,
      description: data.description,
      due_date: data.due_date,
      priority: data.priority,
      status: data.status,
    });
    const sets = clause ? [clause] : [];
    // completed_at follows a status change: set when moving to done, cleared
    // when moving to any other status.
    if (data.status !== undefined) {
      sets.push(data.status === 'done' ? 'completed_at = now()' : 'completed_at = NULL');
    }
    if (!sets.length) throw new HttpError(400, 'No fields to update');
    const { rows } = await query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      [req.params.id, ...values],
    );
    if (!rows[0]) throw new HttpError(404, 'Task not found');
    res.json(rows[0]);
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rowCount } = await query('DELETE FROM tasks WHERE id = $1', [
      req.params.id,
    ]);
    if (!rowCount) throw new HttpError(404, 'Task not found');
    res.status(204).end();
  }),
);

export default router;
