import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, HttpError, parse } from '../lib/http.js';

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
    const completed = data.status === 'done';
    const { rows } = await query(
      `UPDATE tasks SET
         company_id = COALESCE($2, company_id),
         title = COALESCE($3, title),
         description = COALESCE($4, description),
         due_date = COALESCE($5, due_date),
         priority = COALESCE($6, priority),
         status = COALESCE($7, status),
         completed_at = CASE
           WHEN $7 = 'done' THEN now()
           WHEN $7 IS NOT NULL THEN NULL
           ELSE completed_at END
       WHERE id = $1 RETURNING *`,
      [
        req.params.id,
        data.company_id ?? null,
        data.title ?? null,
        data.description ?? null,
        data.due_date ?? null,
        data.priority ?? null,
        data.status ?? null,
      ],
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
