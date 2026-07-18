import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, HttpError, parse } from '../lib/http.js';
import { config } from '../config.js';
import { ruleFor } from '../services/complaintRules.js';
import { researchOrganisation } from '../services/orgResearch.js';

const router = Router();

const ORG_TYPES = [
  'council',
  'housing_association',
  'water',
  'energy',
  'supplier',
  'other',
];

const input = z.object({
  name: z.string().min(1),
  type: z.enum(ORG_TYPES).optional(),
  location: z.string().optional().nullable(),
  complaints_email: z.string().optional().nullable(),
  complaints_url: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  ombudsman_name: z.string().optional().nullable(),
  ombudsman_url: z.string().optional().nullable(),
  ombudsman_referral_months: z.number().int().optional().nullable(),
  stage1_response_days: z.number().int().optional().nullable(),
  stage2_response_days: z.number().int().optional().nullable(),
  ack_days: z.number().int().optional().nullable(),
  procedure_summary: z.string().optional().nullable(),
  legal_basis: z.string().optional().nullable(),
  sources: z.array(z.object({ title: z.string(), url: z.string() })).optional().nullable(),
  research_status: z.enum(['none', 'researched', 'manual']).optional(),
  notes: z.string().optional().nullable(),
});

const COLS = `id, name, type, location, complaints_email, complaints_url, phone,
  ombudsman_name, ombudsman_url, ombudsman_referral_months, stage1_response_days,
  stage2_response_days, ack_days, procedure_summary, legal_basis, sources,
  research_status, researched_at, notes, created_at, updated_at`;

// Is AI research available?
router.get(
  '/research/config',
  asyncHandler(async (_req, res) => {
    res.json({ enabled: config.anthropic.enabled });
  }),
);

// Research an organisation's complaints procedure WITHOUT saving (preview).
router.post(
  '/research',
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const type = ORG_TYPES.includes(req.body?.type) ? req.body.type : 'council';
    const location = req.body?.location || null;
    if (!name) throw new HttpError(400, 'name is required');
    const profile = await researchOrganisation({ name, type, location });
    res.json(profile);
  }),
);

// Research a provider AND save it as an organisation in one step. If one with
// the same name already exists, return that instead of duplicating.
router.post(
  '/research-and-create',
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const type = ORG_TYPES.includes(req.body?.type) ? req.body.type : 'council';
    const location = req.body?.location || null;
    if (!name) throw new HttpError(400, 'name is required');

    const existing = await query(
      `SELECT ${COLS} FROM organisations WHERE lower(name) = lower($1) LIMIT 1`,
      [name],
    );
    if (existing.rows[0]) {
      return res.status(200).json({ ...existing.rows[0], existed: true });
    }

    const p = await researchOrganisation({ name, type, location });
    const { rows } = await query(
      `INSERT INTO organisations
        (name, type, location, complaints_email, complaints_url, phone,
         ombudsman_name, ombudsman_url, ombudsman_referral_months,
         stage1_response_days, stage2_response_days, ack_days,
         procedure_summary, legal_basis, sources, research_status, researched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'researched',now())
       RETURNING ${COLS}`,
      [
        name, type, location, p.complaints_email || null, p.complaints_url || null,
        p.phone || null, p.ombudsman_name || null, p.ombudsman_url || null,
        p.ombudsman_referral_months ?? null, p.stage1_response_days ?? null,
        p.stage2_response_days ?? null, p.ack_days ?? null,
        p.procedure_summary || null, p.legal_basis || null,
        p.sources ? JSON.stringify(p.sources) : null,
      ],
    );
    res.status(201).json(rows[0]);
  }),
);

// Type defaults (used to show the "why" and as a manual fallback).
router.get(
  '/defaults/:type',
  asyncHandler(async (req, res) => {
    res.json(ruleFor(req.params.type));
  }),
);

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const { rows } = await query(
      `SELECT o.*, (SELECT count(*) FROM complaints c WHERE c.organisation_id = o.id) AS complaint_count
         FROM organisations o ORDER BY name ASC`,
    );
    res.json(rows);
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query(`SELECT ${COLS} FROM organisations WHERE id = $1`, [
      req.params.id,
    ]);
    if (!rows[0]) throw new HttpError(404, 'Organisation not found');
    res.json(rows[0]);
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const d = parse(input, req.body);
    const { rows } = await query(
      `INSERT INTO organisations
        (name, type, location, complaints_email, complaints_url, phone,
         ombudsman_name, ombudsman_url, ombudsman_referral_months,
         stage1_response_days, stage2_response_days, ack_days,
         procedure_summary, legal_basis, sources, research_status, researched_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
         ${d.research_status === 'researched' ? 'now()' : 'NULL'}, $17)
       RETURNING ${COLS}`,
      [
        d.name, d.type || 'council', d.location || null, d.complaints_email || null,
        d.complaints_url || null, d.phone || null, d.ombudsman_name || null,
        d.ombudsman_url || null, d.ombudsman_referral_months ?? null,
        d.stage1_response_days ?? null, d.stage2_response_days ?? null,
        d.ack_days ?? null, d.procedure_summary || null, d.legal_basis || null,
        d.sources ? JSON.stringify(d.sources) : null, d.research_status || 'none',
        d.notes || null,
      ],
    );
    res.status(201).json(rows[0]);
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const d = parse(input, req.body);
    const { rows } = await query(
      `UPDATE organisations SET
        name=$2, type=$3, location=$4, complaints_email=$5, complaints_url=$6, phone=$7,
        ombudsman_name=$8, ombudsman_url=$9, ombudsman_referral_months=$10,
        stage1_response_days=$11, stage2_response_days=$12, ack_days=$13,
        procedure_summary=$14, legal_basis=$15, sources=$16,
        research_status=COALESCE($17, research_status),
        -- Only stamp researched_at the first time an org becomes 'researched';
        -- an ordinary edit re-sends research_status='researched' and must not
        -- reset the "researched N days ago" timestamp.
        researched_at=CASE WHEN $17='researched' AND researched_at IS NULL THEN now()
                           ELSE researched_at END,
        notes=$18
       WHERE id=$1 RETURNING ${COLS}`,
      [
        req.params.id, d.name, d.type || 'council', d.location || null,
        d.complaints_email || null, d.complaints_url || null, d.phone || null,
        d.ombudsman_name || null, d.ombudsman_url || null, d.ombudsman_referral_months ?? null,
        d.stage1_response_days ?? null, d.stage2_response_days ?? null, d.ack_days ?? null,
        d.procedure_summary || null, d.legal_basis || null,
        d.sources ? JSON.stringify(d.sources) : null, d.research_status || null,
        d.notes || null,
      ],
    );
    if (!rows[0]) throw new HttpError(404, 'Organisation not found');
    res.json(rows[0]);
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rowCount } = await query('DELETE FROM organisations WHERE id = $1', [
      req.params.id,
    ]);
    if (!rowCount) throw new HttpError(404, 'Organisation not found');
    res.status(204).end();
  }),
);

export default router;
