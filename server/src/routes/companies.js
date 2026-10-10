import { Router } from 'express';
import { z } from 'zod';
import { query, pool } from '../db/pool.js';
import { asyncHandler, HttpError, parse, requireUuidParam, optionalIsoDate } from '../lib/http.js';
import {
  getCompanyProfile,
  searchCompanies,
  normaliseCompanyNumber,
} from '../services/companiesHouse.js';
import {
  upsertKeyDates,
  syncCompany,
  syncAllCompanies,
} from '../services/companySync.js';
import { config } from '../config.js';
import { buildUpdateSet } from '../lib/sql.js';
import { can } from '../services/permissions.js';

const router = Router();
// Every :id route on this router is a UUID primary key — reject anything else
// with a clean 400 instead of a raw Postgres "invalid input syntax" 500.
router.param('id', requireUuidParam);

const companyInput = z.object({
  name: z.string().min(1),
  company_number: z.string().trim().optional().nullable(),
  status: z.enum(['active', 'dormant', 'dissolved', 'other']).optional(),
  incorporation_date: optionalIsoDate,
  accounts_next_due: optionalIsoDate,
  accounts_next_made_up_to: optionalIsoDate,
  confirmation_statement_next_due: optionalIsoDate,
  confirmation_statement_next_made_up_to: optionalIsoDate,
  registered_office: z.string().optional().nullable(),
  sic_codes: z.array(z.string()).optional().nullable(),
  notes: z.string().optional().nullable(),
});

const COLS = `id, name, company_number, status, incorporation_date,
  accounts_next_due, accounts_next_made_up_to, confirmation_statement_next_due,
  confirmation_statement_next_made_up_to,
  registered_office, sic_codes, notes, ch_last_synced_at, created_at, updated_at`;

// Re-sync every company from Companies House on demand (dashboard button).
// No emails — just refreshes statutory dates so an item already filed at CH
// rolls forward and drops off the overdue list without waiting for the nightly
// reminder cron. Best-effort per company.
//
// In the background, like the reminder run: one Companies House call per
// company (each waiting out its rate limit) outlasts nginx's 60 seconds once
// there are a few dozen, so the button showed an error while the sync carried
// on, and a second press started a second sync. POST answers 202 at once (409
// while one runs) and GET /sync-all says how it went.
let syncRun = null;

router.post(
  '/sync-all',
  asyncHandler(async (req, res) => {
    if (syncRun?.status === 'running') {
      return res.status(409).json({ error: 'Companies House is already being synced. It takes a minute or two.', run: syncRun });
    }
    syncRun = { status: 'running', started_at: new Date().toISOString(), by: req.user?.email || null };
    const run = syncRun;
    syncAllCompanies()
      .then((result) => Object.assign(run, { status: 'done', finished_at: new Date().toISOString(), result: { ...result, failures: result.failures?.slice(0, 20) } }))
      .catch((err) => {
        console.error('[companies] sync all failed:', err);
        Object.assign(run, { status: 'failed', finished_at: new Date().toISOString(), error: err.message });
      });
    res.status(202).json({ started: true, run: syncRun });
  }),
);

router.get(
  '/sync-all',
  asyncHandler(async (_req, res) => {
    res.json(syncRun || { status: 'never' });
  }),
);

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
      // % and _ are LIKE's wildcards: searched for as typed ("50%" isn't "50 anything").
      params.push(`%${search.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
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
    // Its tasks only for someone who may see Tasks: the company page is
    // reached with Companies access alone.
    const showTasks = can(req.user, 'tasks');
    const tasks = !showTasks ? [] : (
      await query(
        `SELECT * FROM tasks WHERE company_id = $1 ORDER BY
           (status = 'done'), due_date NULLS LAST`,
        [req.params.id],
      )
    ).rows;

    res.json({ ...rows[0], key_dates: keyDates, tasks, tasks_hidden: !showTasks });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = parse(companyInput, req.body);
    let row;
    try {
      row = await insertCompany(data);
    } catch (err) {
      throw duplicateNumber(err);
    }
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
      // Two imports of the same number at once: the second meets the index.
      throw duplicateNumber(err);
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

    await syncCompany(req.params.id, existing.rows[0].company_number);

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
    // Only the fields sent: an omitted one is left as it is (a full-row
    // update wiped notes, SIC codes and dates it wasn't given).
    const data = parse(companyInput.partial(), req.body);
    const { clause, values } = buildUpdateSet({
      name: data.name,
      company_number: data.company_number === undefined ? undefined
        : data.company_number ? normaliseCompanyNumber(data.company_number) : null, // as Companies House writes it, so a typed and an imported company match
      status: data.status,
      incorporation_date: data.incorporation_date,
      accounts_next_due: data.accounts_next_due,
      confirmation_statement_next_due: data.confirmation_statement_next_due,
      registered_office: data.registered_office,
      sic_codes: data.sic_codes,
      notes: data.notes,
      accounts_next_made_up_to: data.accounts_next_made_up_to,
      confirmation_statement_next_made_up_to: data.confirmation_statement_next_made_up_to,
    });
    if (!clause) throw new HttpError(400, 'No fields to update');
    let rows;
    try {
      ({ rows } = await query(`UPDATE companies SET ${clause} WHERE id = $1 RETURNING ${COLS}`, [req.params.id, ...values]));
    } catch (err) {
      throw duplicateNumber(err);
    }
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

// A company number already on file is a clear 409, not "Internal server error".
function duplicateNumber(err) {
  if (err?.code === '23505') return new HttpError(409, 'A company with that number is already on file.');
  return err;
}

async function insertCompany(data, client = { query }) {
  const { rows } = await client.query(
    `INSERT INTO companies
       (name, company_number, status, incorporation_date, accounts_next_due,
        confirmation_statement_next_due, registered_office, sic_codes, notes,
        accounts_next_made_up_to, confirmation_statement_next_made_up_to,
        ch_last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, ${
       data.ch_last_synced_at ? 'now()' : 'NULL'
     })
     RETURNING ${COLS}`,
    [
      data.name,
      data.company_number ? normaliseCompanyNumber(data.company_number) : null, // as Companies House writes it, so a typed and an imported company match
      data.status || 'active',
      data.incorporation_date || null,
      data.accounts_next_due || null,
      data.confirmation_statement_next_due || null,
      data.registered_office || null,
      data.sic_codes || null,
      data.notes || null,
      data.accounts_next_made_up_to || null,
      data.confirmation_statement_next_made_up_to || null,
    ],
  );
  return rows[0];
}

export default router;
