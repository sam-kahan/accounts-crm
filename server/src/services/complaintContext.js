import { query } from '../db/pool.js';
import { HttpError } from '../lib/http.js';
import { complaintEmailAddress } from '../config.js';
import {
  computeAckDue,
  computeOmbudsmanFrom,
  deriveStatus,
  procedureSteps,
} from './complaintRules.js';
import { ruleForComplaint } from './complaintDeadlines.js';
import { listComplaintEmails } from './emailIngest.js';
import { attachmentTexts, attachmentBlocks } from './attachments.js';

// ---------------------------------------------------------------------------
// A complaint with everything worked out about it (status, procedure
// checklist, org context), and the full context the AI reads. Shared by the
// routes, the email processor and the automatic review, so all three see the
// same complaint.
// ---------------------------------------------------------------------------

// Attach derived status + rule + procedure checklist + org context to a row.
export async function decorate(c) {
  const { org, rule } = await ruleForComplaint(c);
  const derived = deriveStatus(c, rule);
  return {
    ...c,
    ...derived,
    rule,
    ack_due: computeAckDue(c, rule),
    ombudsman_from: computeOmbudsmanFrom(c, rule),
    steps: procedureSteps(c, rule),
    email_address: complaintEmailAddress(c.ref_code),
    org_email: org?.complaints_email || null,
    org_complaints_url: org?.complaints_url || null,
    // What the deadlines rest on, so the page can say how far to trust them.
    procedure: org
      ? {
          organisation_id: org.id,
          name: org.name,
          procedure_ref: org.procedure_ref,
          procedure_summary: org.procedure_summary,
          sources: org.sources || [],
          evidence: org.procedure_evidence || {},
          research_status: org.research_status,
          verified_at: org.verified_at,
          verified_by: org.verified_by,
        }
      : null,
  };
}

// Gather a complaint's full context (row + rule + timeline + emails + attachment
// text) for the AI endpoints. Throws 404 if the complaint doesn't exist.
export async function gatherContext(id, extraContext) {
  const { rows } = await query('SELECT * FROM complaints WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Complaint not found');
  const complaint = await decorate(rows[0]);
  const events = (
    await query(
      'SELECT * FROM complaint_events WHERE complaint_id = $1 ORDER BY event_date DESC, created_at DESC',
      [id],
    )
  ).rows;
  const emails = await listComplaintEmails(id);
  const docs = await attachmentTexts(id);
  const docText = docs.length
    ? docs.map((a) => `--- Attached document: ${a.filename} ---\n${a.extracted_text}`).join('\n\n')
    : '';
  const merged = [extraContext, docText].filter(Boolean).join('\n\n');
  // PDFs and photos can't be turned into text here, so they go to the model
  // as documents in their own right — letters and statements are mostly PDFs.
  const blocks = await attachmentBlocks(id);
  return { complaint, rule: complaint.rule, events, emails, extraContext: merged, blocks };
}

