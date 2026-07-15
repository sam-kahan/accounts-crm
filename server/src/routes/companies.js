import { Router } from 'express';
import { z } from 'zod';
import { query, pool } from '../db/pool.js';
import { asyncHandler, HttpError, parse } from '../lib/http.js';
import {
  getCompanyProfile,
  searchCompanies,
  normaliseCompanyNumber,
} from '../services/companiesHouse.js';
import { config } from '../config.js';

const router = Router();

const companyInput = z.object({
  name: z.string().min(1),
  company_number: z.string().trim().optional().nullable(),
  status: z.enum(['active', 'dormant', 'dissolved', 'other']).optional(),
  incorporation_date: z.string().optional().nullable(),
  accounts_next_due: z.string().optional().nullable(),
  confirmation_statement_next_due: z.string().optional().nullable(),
  registered_office: z.string().optional().nullable(),
  sic_codes: z.array(z.string()).optional().nullable(),
  notes: z.string().optional().nullable(),
});

const COLS = `id, name, company_number, status, incorporation_date,
  accounts_next_due, confirmation_statement_next_due, registered_office,
  sic_codes, notes, ch_last_synced_at, created_at, updated_at`;

// --- Companies House lookup (search + profile preview) ---------------------
// These come before /:id so "search" isn't treated as an id.

router.get(
  '/ch/config',
  asyncHandler(async (_req, res) => {
    res.json({ enabled: config.companiesHouse.enabled });
  }),
);

router.get(
  '/ch/search',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) throw new HttpError(400, 'Missing search term ?q=');
    res.json(await searchCompanies(q));
  }),
);

router.get(
  '/ch/:number',
  asyncHandler(async (req, res) => {
    const { company, keyDates } = await getCompanyProfile(req.params.number);
    res.json({ company, keyDates });
  }),
);

// --- CRUD ------------------------------------------------------------------

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const search = String(req.query.search || '').trim();
    const params = [];
    let where = '';
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where = `WHERE lower(name) LIKE $1 OR lower(coalesce(company_number,'')) LIKE $1`;
    }
    const { rows } = await query(
      `SELECT ${COLS} FROM companies ${where} ORDER BY name ASC`,
      params,
    );
    res.json(rows);
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT ${COLS} FROM companies WHERE id = $1`,
      [req.params.id],
    );
    if (!rows[0]) throw new HttpError(404, 'Company not found');

    const keyDates = (
      await query(
        `SELECT * FROM key_dates WHERE company_id = $1 ORDER BY due_date ASC`,
        [req.params.id],
      )
    ).rows;
    const tasks = (
      await query(
        `SELECT * FROM tasks WHERE company_id = $1 ORDER BY
           (status = 'done'), due_date NULLS LAST`,
        [req.params.id],
      )
    ).rows;

    res.json({ ...rows[0], key_dates: keyDates, tasks });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = parse(companyInput, req.body);
    const row = await insertCompany(data);
    res.status(201).json(row);
  }),
);

// Import straight from Companies House by number (fetch + create + key dates).
router.post(
  '/import',
  asyncHandler(async (req, res) => {
    const number = normaliseCompanyNumber(req.body?.company_number);
    if (!number) throw new HttpError(400, 'company_number is required');

    const { company, keyDates } = await getCompanyProfile(number);

    const existing = await query(
      'SELECT id FROM companies WHERE company_number = $1',
      [company.company_number],
    );
    if (existing.rows[0]) {
      throw new HttpError(409, 'Company already exists', {
        id: existing.rows[0].id,
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await insertCompany(
        { ...company, ch_last_synced_at: true },
        client,
      );
      await upsertKeyDates(inserted.id, keyDates, client);
      await client.query('COMMIT');
      res.status(201).json(inserted);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
);

// Re-sync an existing company's statutory dates from Companies House.
router.post(
  '/:id/sync',
  asyncHandler(async (req, res) => {
    const existing = await query(
      'SELECT id, company_number FROM companies WHERE id = $1',
      [req.params.id],
    );
    if (!existing.rows[0]) throw new HttpError(404, 'Company not found');
    if (!existing.rows[0].company_number)
      throw new HttpError(400, 'Company has no company number to sync');

    const { company, keyDates } = await getCompanyProfile(
      existing.rows[0].company_number,
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE companies SET
           name = $2, status = $3, incorporation_date = $4,
           accounts_next_due = $5, confirmation_statement_next_due = $6,
           registered_office = $7, sic_codes = $8, ch_last_synced_at = now()
         WHERE id = $1`,
        [
          req.params.id,
          company.name,
          company.status,
          company.incorporation_date,
          company.accounts_next_due,
          company.confirmation_statement_next_due,
          company.registered_office,
          company.sic_codes,
        ],
      );
      await upsertKeyDates(req.params.id, keyDates, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const { rows } = await query(
      `SELECT ${COLS} FROM companies WHERE id = $1`,
      [req.params.id],
    );
    res.json(rows[0]);
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = parse(companyInput, req.body);
    const { rows } = await query(
      `UPDATE companies SET
         name = $2, company_number = $3, status = $4, incorporation_date = $5,
         accounts_next_due = $6, confirmation_statement_next_due = $7,
         registered_office = $8, sic_codes = $9, notes = $10
       WHERE id = $1 RETURNING ${COLS}`,
      [
        req.params.id,
        data.name,
        data.company_number || null,
        data.status || 'active',
        data.incorporation_date || null,
        data.accounts_next_due || null,
        data.confirmation_statement_next_due || null,
        data.registered_office || null,
        data.sic_codes || null,
        data.notes || null,
      ],
    );
    if (!rows[0]) throw new HttpError(404, 'Company not found');
    res.json(rows[0]);
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rowCount } = await query('DELETE FROM companies WHERE id = $1', [
      req.params.id,
    ]);
    if (!rowCount) throw new HttpError(404, 'Company not found');
    res.status(204).end();
  }),
);

// --- helpers ---------------------------------------------------------------

async function insertCompany(data, client = { query }) {
  const { rows } = await client.query(
    `INSERT INTO companies
       (name, company_number, status, incorporation_date, accounts_next_due,
        confirmation_statement_next_due, registered_office, sic_codes, notes,
        ch_last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, ${
       data.ch_last_synced_at ? 'now()' : 'NULL'
     })
     RETURNING ${COLS}`,
    [
      data.name,
      data.company_number || null,
      data.status || 'active',
      data.incorporation_date || null,
      data.accounts_next_due || null,
      data.confirmation_statement_next_due || null,
      data.registered_office || null,
      data.sic_codes || null,
      data.notes || null,
    ],
  );
  return rows[0];
}

// Insert/update Companies-House-owned key dates in place (unique per category).
async function upsertKeyDates(companyId, keyDates, client) {
  for (const kd of keyDates) {
    await client.query(
      `INSERT INTO key_dates
         (company_id, category, title, due_date, recurrence, source)
       VALUES ($1,$2,$3,$4,$5,'companies_house')
       ON CONFLICT (company_id, category) WHERE (source = 'companies_house')
       DO UPDATE SET title = EXCLUDED.title, due_date = EXCLUDED.due_date,
                     recurrence = EXCLUDED.recurrence, status = 'pending'`,
      [companyId, kd.category, kd.title, kd.due_date, kd.recurrence],
    );
  }
}

export default router;
