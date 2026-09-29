import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, HttpError, parse, requireUuidParam, attachmentDisposition } from '../lib/http.js';
import { config } from '../config.js';
import { ruleFor, ombudsmanUrlFor } from '../services/complaintRules.js';
import { researchOrganisation, readProcedureDocument } from '../services/orgResearch.js';
import { recomputeForOrganisation } from '../services/complaintDeadlines.js';
import { procedureChanged, statesOwnProcedure } from '../services/orgProcedure.js';
import { findOrgByName } from '../services/orgMatch.js';
import {
  orgDocumentUpload,
  procedureMemoryUpload,
  listOrgDocuments,
  saveOrgDocument,
  getOrgDocument,
  deleteOrgDocument,
  orgDocumentFiles,
  removeOrgFiles,
} from '../services/attachments.js';

const router = Router();
// Every :id route on this router is a UUID primary key — reject anything else
// with a clean 400 instead of a raw Postgres "invalid input syntax" 500.
router.param('id', requireUuidParam);

const ORG_TYPES = [
  'council',
  'housing_association',
  'water',
  'energy',
  'managing_agent',
  'debt_collector',
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
  ombudsman_referral_months: z.number().int().min(1).max(120).optional().nullable(),
  stage1_response_days: z.number().int().min(1).max(400).optional().nullable(),
  stage2_response_days: z.number().int().min(1).max(400).optional().nullable(),
  ack_days: z.number().int().min(1).max(400).optional().nullable(),
  procedure_ref: z.string().max(200).optional().nullable(),
  stage1_clock: z.enum(['receipt', 'acknowledgement']).optional().nullable(),
  ombudsman_after_weeks: z.number().int().min(1).max(104).optional().nullable(),
  referral_from: z.enum(['raised', 'final_response']).optional().nullable(),
  procedure_summary: z.string().optional().nullable(),
  legal_basis: z.string().optional().nullable(),
  sources: z.array(z.object({ title: z.string(), url: z.string() })).optional().nullable(),
  unconfirmed: z.array(z.string()).optional().nullable(),
  procedure_evidence: z.record(z.string()).optional().nullable(),
  procedure_sources: z.record(z.enum(['document', 'research', 'entered', 'standard'])).optional().nullable(),
  // Their website was researched just now (recorded, so nobody is asked to do it again).
  researched_now: z.boolean().optional(),
  research_status: z.enum(['none', 'researched', 'document', 'manual']).optional(),
  // "I have checked these against their published procedure." Sent on every
  // save: ticking it stamps who and when; saving without it clears the stamp,
  // so an edit to a checked procedure has to be checked again.
  verified: z.boolean().optional(),
  notes: z.string().optional().nullable(),
  // The ombudsman scheme it belongs to (the register), when it isn't the
  // usual one for its type; null = the usual one. Omitted = left as it is.
  ombudsman_id: z.string().uuid().optional().nullable(),
});

// The scheme chosen on the form, saved alongside (a managing agent is TPO or
// PRS; a supplier may belong to none).
async function saveScheme(org, d) {
  if (d.ombudsman_id === undefined) return org;
  const { rows } = await query(`UPDATE organisations SET ombudsman_id = $2 WHERE id = $1 RETURNING ombudsman_id`, [org.id, d.ombudsman_id]);
  return { ...org, ombudsman_id: rows[0]?.ombudsman_id ?? null };
}

const COLS = `id, name, type, location, complaints_email, complaints_url, phone,
  ombudsman_name, ombudsman_url, ombudsman_referral_months, stage1_response_days,
  stage2_response_days, ack_days, procedure_ref, stage1_clock, ombudsman_after_weeks,
  referral_from, procedure_summary, legal_basis, sources, unconfirmed, procedure_evidence,
  procedure_sources, research_status, researched_at, verified_at, verified_by, notes, ombudsman_id, created_at, updated_at`;

const who = (req) => req.user?.name || req.user?.email || null;

// Where each figure came from (migration 027), saved alongside the figures.
async function saveSources(row, d) {
  if (!row || (d.procedure_sources === undefined && !d.researched_now)) return row;
  const { rows } = await query(
    `UPDATE organisations
        SET procedure_sources = CASE WHEN $3 THEN $2::jsonb ELSE procedure_sources END,
            researched_at = CASE WHEN $4 THEN now() ELSE researched_at END
      WHERE id = $1 RETURNING ${COLS}`,
    [row.id, d.procedure_sources && Object.keys(d.procedure_sources).length ? JSON.stringify(d.procedure_sources) : null,
      d.procedure_sources !== undefined, Boolean(d.researched_now)],
  );
  return rows[0];
}

// The column values shared by create and update, in COLS-free order.
function values(d) {
  return [
    d.name, d.type || 'council', d.location || null, d.complaints_email || null,
    d.complaints_url || null, d.phone || null, d.ombudsman_name || null,
    // Left blank for a scheme we know, the website is filled in from its name.
    d.ombudsman_url || ombudsmanUrlFor(d.ombudsman_name) || null,
    d.ombudsman_referral_months ?? null,
    d.stage1_response_days ?? null, d.stage2_response_days ?? null, d.ack_days ?? null,
    d.procedure_ref || null, d.stage1_clock || null, d.ombudsman_after_weeks ?? null,
    d.referral_from || null, d.procedure_summary || null, d.legal_basis || null,
    d.sources ? JSON.stringify(d.sources) : null, d.unconfirmed?.length ? d.unconfirmed : null,
    d.procedure_evidence && Object.keys(d.procedure_evidence).length
      ? JSON.stringify(d.procedure_evidence)
      : null,
    d.notes || null,
  ];
}

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

// Read the organisation's own procedure document WITHOUT saving. The values
// come back for the user to check; the file is stored when they save.
router.post(
  '/procedure/read',
  procedureMemoryUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Attach the procedure document');
    const type = ORG_TYPES.includes(req.body?.type) ? req.body.type : null;
    const profile = await readProcedureDocument(req.file, { name: req.body?.name, type });
    res.json(profile);
  }),
);

// Research a provider AND save it as an organisation in one step. If one with
// the same name already exists, return that instead of duplicating. Saved as
// researched but NOT checked — the complaint page says so until someone has.
router.post(
  '/research-and-create',
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const type = ORG_TYPES.includes(req.body?.type) ? req.body.type : 'council';
    const location = req.body?.location || null;
    if (!name) throw new HttpError(400, 'name is required');

    // The same rule imports use ("OVO" is "OVO Energy"), so a name written
    // differently never pays for research and a second organisation.
    const match = await findOrgByName(name);
    if (match) {
      const { rows: [row] } = await query(`SELECT ${COLS} FROM organisations WHERE id = $1`, [match.id]);
      return res.status(200).json({ ...row, existed: true });
    }

    const p = await researchOrganisation({ name, type, location });
    const { rows } = await query(
      `INSERT INTO organisations
        (name, type, location, complaints_email, complaints_url, phone,
         ombudsman_name, ombudsman_url, ombudsman_referral_months,
         stage1_response_days, stage2_response_days, ack_days,
         procedure_ref, stage1_clock, ombudsman_after_weeks, referral_from,
         procedure_summary, legal_basis, sources, unconfirmed, procedure_evidence, notes,
         research_status, researched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
               'researched', now())
       RETURNING ${COLS}`,
      values({ ...p, name, type, location, procedure_evidence: p.evidence }),
    );
    // Each figure it found is marked as researched, so it is described as
    // their published information (and research may later update it).
    const found = Object.fromEntries(
      ['ack_days', 'stage1_response_days', 'stage2_response_days', 'stage1_clock', 'ombudsman_name', 'ombudsman_url',
        'ombudsman_referral_months', 'referral_from', 'ombudsman_after_weeks']
        .filter((k) => p[k] !== null && p[k] !== undefined && p[k] !== '').map((k) => [k, 'research']),
    );
    res.status(201).json(await saveSources(rows[0], { procedure_sources: found }));
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
      `SELECT o.*,
              ((SELECT count(*) FROM complaints c WHERE c.organisation_id = o.id)
               + (SELECT count(*) FROM complaint_parties p WHERE p.organisation_id = o.id)) AS complaint_count,
              (SELECT count(*) FROM organisation_documents d WHERE d.organisation_id = o.id) AS document_count,
              -- Their complaints address bounced and nobody has looked into it yet.
              EXISTS (SELECT 1 FROM email_bounces b WHERE b.resolved_at IS NULL
                        AND b.address = lower(o.complaints_email)) AS email_bounced
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
    res.json({ ...rows[0], documents: await listOrgDocuments(req.params.id) });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const d = parse(input, req.body);
    // Standard figures alone are not a procedure someone entered.
    const status = d.research_status === 'manual' && !statesOwnProcedure(d) ? 'none' : d.research_status || 'none';
    const { rows } = await query(
      `INSERT INTO organisations
        (name, type, location, complaints_email, complaints_url, phone,
         ombudsman_name, ombudsman_url, ombudsman_referral_months,
         stage1_response_days, stage2_response_days, ack_days,
         procedure_ref, stage1_clock, ombudsman_after_weeks, referral_from,
         procedure_summary, legal_basis, sources, unconfirmed, procedure_evidence, notes,
         research_status, researched_at, verified_at, verified_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
               $23, ${status === 'researched' ? 'now()' : 'NULL'},
               ${d.verified ? 'now()' : 'NULL'}, $24)
       RETURNING ${COLS}`,
      [...values(d), status, d.verified ? who(req) : null],
    );
    const saved = await saveScheme(await saveSources(rows[0], d), d);
    res.status(201).json(saved);
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const d = parse(input, req.body);
    const old = (await query('SELECT * FROM organisations WHERE id = $1', [req.params.id])).rows[0];
    if (!old) throw new HttpError(404, 'Organisation not found');
    // Did anything that sets a date change? (orgProcedure.js: a figure only
    // showing the standard is not a change, a new scheme is.)
    const [, type, , , , , ombudsman_name, ombudsman_url, ombudsman_referral_months, stage1_response_days,
      stage2_response_days, ack_days, procedure_ref, stage1_clock, ombudsman_after_weeks, referral_from] = values(d);
    const changed = procedureChanged(old, {
      type, ombudsman_name, ombudsman_url, ombudsman_referral_months, stage1_response_days, stage2_response_days,
      ack_days, procedure_ref, stage1_clock, ombudsman_after_weeks, referral_from,
      procedure_sources: d.procedure_sources, ombudsman_id: d.ombudsman_id,
    });
    // "Checked by X on date" stays X's when nothing procedural changed (a
    // phone number, a note), is stamped afresh when it did, and is cleared
    // when saved without the tick.
    const keepCheck = d.verified && old.verified_at && !changed;
    const verifiedAt = !d.verified ? null : keepCheck ? old.verified_at : new Date();
    const verifiedBy = !d.verified ? null : keepCheck ? old.verified_by : who(req);
    // Standard figures alone are not a procedure someone entered.
    const status = d.research_status === 'manual' && (old.research_status || 'none') === 'none' && !statesOwnProcedure(d)
      ? 'none' : d.research_status || null;
    const { rows } = await query(
      `UPDATE organisations SET
        name=$2, type=$3, location=$4, complaints_email=$5, complaints_url=$6, phone=$7,
        ombudsman_name=$8, ombudsman_url=$9, ombudsman_referral_months=$10,
        stage1_response_days=$11, stage2_response_days=$12, ack_days=$13,
        procedure_ref=$14, stage1_clock=$15, ombudsman_after_weeks=$16, referral_from=$17,
        procedure_summary=$18, legal_basis=$19, sources=$20, unconfirmed=$21,
        procedure_evidence=$22, notes=$23,
        research_status=COALESCE($24, research_status),
        -- researched_at says their WEBSITE was researched, so only research
        -- stamps it (reading their document is not research). A plain edit
        -- re-sends the same status and must not move the date.
        researched_at=CASE WHEN $24 = 'researched' AND $24 IS DISTINCT FROM research_status
                           THEN now()
                           WHEN $24 = 'researched' AND researched_at IS NULL THEN now()
                           ELSE researched_at END,
        verified_at=$25, verified_by=$26
       WHERE id=$1 RETURNING ${COLS}`,
      [req.params.id, ...values(d), status, verifiedAt, verifiedBy],
    );
    if (!rows[0]) throw new HttpError(404, 'Organisation not found');
    rows[0] = await saveScheme(await saveSources(rows[0], d), d);
    // A linked complaint takes its type from the organisation (the type sets
    // the defaults for anything the procedure doesn't state).
    await query('UPDATE complaints SET org_type = $2 WHERE organisation_id = $1', [req.params.id, rows[0].type]);
    await query('UPDATE complaint_parties SET org_type = $2 WHERE organisation_id = $1', [req.params.id, rows[0].type]);
    // Its open complaints are re-dated from the procedure as it now stands;
    // their AI reviews are refreshed only when the procedure changed (a
    // phone number or a note isn't worth a review each).
    const recalculated = await recomputeForOrganisation(req.params.id, [], { reviewAll: changed });
    res.json({ ...rows[0], recalculated });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    // Complaints against it keep their snapshot of its name and fall back to
    // the type defaults, so re-date the open ones once it's gone.
    const linked = (
      await query(`SELECT id FROM complaints WHERE organisation_id = $1 AND state = 'open'`, [
        req.params.id,
      ])
    ).rows.map((r) => r.id);
    // Also where it is a further organisation on a complaint (migration 029).
    const linkedParties = (
      await query(`SELECT id FROM complaint_parties WHERE organisation_id = $1 AND state = 'open'`, [req.params.id])
    ).rows.map((r) => r.id);
    // Its document files, read before the row (and their records) go, are
    // removed only once the delete has succeeded.
    const files = await orgDocumentFiles(req.params.id);
    const { rowCount } = await query('DELETE FROM organisations WHERE id = $1', [
      req.params.id,
    ]);
    if (!rowCount) throw new HttpError(404, 'Organisation not found');
    await removeOrgFiles(files);
    // Re-dated by the type's standard now, each moved date written on the
    // complaint's timeline, the further-party tracks included.
    if (linked.length || linkedParties.length) {
      await recomputeForOrganisation(req.params.id, linked, {
        by: 'Automatic (organisation deleted)', source: 'the standard timescales (their organisation was deleted)', partyIds: linkedParties,
      });
    }
    res.status(204).end();
  }),
);

// --- Procedure documents ----------------------------------------------------
const requireOrgId = asyncHandler(async (req, _res, next) => {
  const { rows } = await query('SELECT id FROM organisations WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Organisation not found');
  next();
});

router.get(
  '/:id/documents',
  asyncHandler(async (req, res) => {
    res.json(await listOrgDocuments(req.params.id));
  }),
);

router.post(
  '/:id/documents',
  requireOrgId,
  orgDocumentUpload.array('files', 5),
  asyncHandler(async (req, res) => {
    const saved = [];
    for (const f of req.files || []) saved.push(await saveOrgDocument(req.params.id, f));
    res.status(201).json(saved);
  }),
);

router.get(
  '/documents/:docId/download',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.docId).success) {
      throw new HttpError(400, 'Invalid document id');
    }
    const doc = await getOrgDocument(req.params.docId);
    if (!doc) throw new HttpError(404, 'Document not found');
    // Always a download, never rendered inline on our origin (see complaints).
    res.setHeader('Content-Type', doc.mimetype || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', attachmentDisposition(doc.filename, 'procedure'));
    doc.stream().pipe(res);
  }),
);

router.delete(
  '/documents/:docId',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.docId).success) {
      throw new HttpError(400, 'Invalid document id');
    }
    const ok = await deleteOrgDocument(req.params.docId);
    if (!ok) throw new HttpError(404, 'Document not found');
    res.status(204).end();
  }),
);

export default router;
