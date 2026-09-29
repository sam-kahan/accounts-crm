import { readable } from '../services/complaintRules.js';
import { Router } from 'express';
import { query } from '../db/pool.js';
import { asyncHandler } from '../lib/http.js';
import { can } from '../services/permissions.js';

// ---------------------------------------------------------------------------
// One search box for the whole system (the top bar): an account number, a
// reference of theirs or ours (GC-C-…, GC-CI-…, GC-COM-…), a company number,
// a name or an address — and straight to the record. Each kind of record is
// searched only for someone who may see that section, so the box can't show
// a glimpse of what their access withholds. Numbers match however they are
// spaced or punctuated ("8500 1234 5678" = "8500-1234-5678").
// ---------------------------------------------------------------------------
const router = Router();
const LIMIT = 6;

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q.length < 2) return res.json({ q, results: [] });
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    // The letters and digits only, for numbers and references.
    const key = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const keyLike = key.length >= 3 ? `%${key}%` : null;
    const norm = (col) => `regexp_replace(upper(COALESCE(${col}, '')), '[^A-Z0-9]', '', 'g')`;
    const results = [];
    const u = req.user;

    if (can(u, 'complaints')) {
      const { rows } = await query(
        `SELECT c.id, c.ref_code, c.subject, c.org_name, c.property, c.state, c.account_numbers, c.reference
           FROM complaints c
          WHERE c.subject ILIKE $1 OR c.property ILIKE $1 OR c.org_name ILIKE $1
             OR ($2::text IS NOT NULL AND (
                  ${norm('c.ref_code')} LIKE $2 OR ${norm('c.reference')} LIKE $2 OR ${norm('c.our_reference')} LIKE $2
                  OR EXISTS (SELECT 1 FROM unnest(c.account_numbers || c.other_references || c.merged_refs) a WHERE ${norm('a')} LIKE $2)))
             OR EXISTS (SELECT 1 FROM complaint_parties p WHERE p.complaint_id = c.id
                         AND (p.org_name ILIKE $1 OR ($2::text IS NOT NULL AND ${norm('p.reference')} LIKE $2)))
          ORDER BY (c.state = 'open') DESC, c.raised_on DESC
          LIMIT ${LIMIT}`,
        [like, keyLike],
      );
      for (const r of rows) {
        results.push({
          kind: 'Complaint', id: r.id, url: `/complaints/${r.id}`,
          title: r.subject,
          detail: [r.ref_code, r.org_name, (r.account_numbers || []).join(', ') || r.reference, r.state === 'open' ? null : 'closed']
            .filter(Boolean).join(' · '),
        });
      }
      const orgs = (await query(
        `SELECT id, name, type FROM organisations WHERE name ILIKE $1 ORDER BY name LIMIT ${LIMIT}`, [like],
      )).rows;
      for (const o of orgs) {
        results.push({ kind: 'Organisation', id: o.id, url: `/organisations?open=${o.id}`, title: o.name, detail: o.type });
      }
    }

    if (can(u, 'companies')) {
      const { rows } = await query(
        `SELECT id, name, company_number, status FROM companies
          WHERE name ILIKE $1 OR ($2::text IS NOT NULL AND ${norm('company_number')} LIKE $2)
          ORDER BY name LIMIT ${LIMIT}`,
        [like, keyLike],
      );
      for (const r of rows) {
        results.push({
          kind: 'Company', id: r.id, url: `/companies/${r.id}`, title: r.name,
          detail: [r.company_number && `No. ${r.company_number}`, r.status !== 'active' ? r.status : null].filter(Boolean).join(' · '),
        });
      }
    }

    if (can(u, 'tasks')) {
      const { rows } = await query(
        `SELECT id, title, due_date, status FROM tasks WHERE title ILIKE $1 ORDER BY (status = 'done'), due_date NULLS LAST LIMIT ${LIMIT}`,
        [like],
      );
      for (const r of rows) {
        results.push({ kind: 'Task', id: r.id, url: '/tasks', title: r.title, detail: [r.due_date && `due ${readable(r.due_date)}`, r.status === 'done' ? 'done' : null].filter(Boolean).join(' · ') });
      }
    }

    if (can(u, 'commission')) {
      const inv = (await query(
        `SELECT i.id, i.ref, i.invoice_number, i.invoice_date::text AS invoice_date, i.property, c.name AS contractor
           FROM contractor_invoices i JOIN contractors c ON c.id = i.contractor_id
          WHERE i.property ILIKE $1 OR c.name ILIKE $1
             OR ($2::text IS NOT NULL AND (${norm('i.ref')} LIKE $2 OR ${norm('i.invoice_number')} LIKE $2))
          ORDER BY i.invoice_date DESC LIMIT ${LIMIT}`,
        [like, keyLike],
      )).rows;
      for (const r of inv) {
        results.push({
          kind: 'Contractor invoice', id: r.id,
          url: `/commission/invoices?month=${r.invoice_date.slice(0, 7)}&search=${encodeURIComponent(r.ref)}`,
          title: `${r.ref}${r.invoice_number ? ` (their ${r.invoice_number})` : ''}`,
          detail: [r.contractor, r.property, r.invoice_date].filter(Boolean).join(' · '),
        });
      }
      const raised = (await query(
        `SELECT ci.id, ci.invoice_number, ci.external_number, ci.status, c.name AS contractor
           FROM commission_invoices ci JOIN contractors c ON c.id = ci.contractor_id
          WHERE $2::text IS NOT NULL AND (${norm('ci.invoice_number')} LIKE $2 OR ${norm('ci.external_number')} LIKE $2)
             OR c.name ILIKE $1
          ORDER BY ci.created_at DESC LIMIT ${LIMIT}`,
        [like, keyLike],
      )).rows;
      for (const r of raised) {
        results.push({
          kind: 'Commission invoice', id: r.id, url: `/commission/raised/${r.id}`,
          title: `${r.invoice_number}${r.external_number ? ` (${r.external_number})` : ''}`,
          detail: [r.contractor, r.status].join(' · '),
        });
      }
      const cons = (await query(`SELECT id, name, trade FROM contractors WHERE name ILIKE $1 ORDER BY name LIMIT ${LIMIT}`, [like])).rows;
      for (const r of cons) results.push({ kind: 'Contractor', id: r.id, url: '/commission/contractors', title: r.name, detail: r.trade || '' });
    }

    res.json({ q, results });
  }),
);

export default router;
