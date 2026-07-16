import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';

// ---------------------------------------------------------------------------
// AI complaint assistant. Given a complaint's full context (organisation, stage,
// statutory deadlines, timeline and logged emails) plus anything the user pastes
// in, Claude produces: a short situation analysis, prioritised next steps, and a
// ready-to-send draft email appropriate to the current stage (chase / escalate /
// ombudsman referral). Reasoning only — no web search, no auto-send; the user
// reviews and sends. Gated on ANTHROPIC_API_KEY.
// ---------------------------------------------------------------------------

let client = null;
function getClient() {
  if (!config.anthropic.enabled) {
    throw new HttpError(
      503,
      'The AI assistant is not configured. Set ANTHROPIC_API_KEY in the server environment.',
    );
  }
  if (!client) client = new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

const SYSTEM = `You are an assistant to a UK accounts/property team that raises complaints against
councils, housing associations, water and energy suppliers and other contractors, and holds them to
their statutory complaint-handling timescales. You help the user move each complaint forward.

You will be given a complaint's full context: the organisation and its complaints procedure + legal
basis, the current stage, the statutory deadlines and whether a response is overdue, the timeline of
events, any emails already logged against it, and optionally extra information or an instruction the
user pasted in.

Produce a firm-but-professional response that:
- Analyses where the complaint stands and what leverage the user has (e.g. a missed statutory
  deadline is itself a complaint-handling failure and strengthens escalation).
- Recommends the single most appropriate next action for THIS stage and status.
- Drafts a complete, ready-to-send email for that action, in UK business English, addressed to the
  organisation. Reference their own procedure and the relevant law/ombudsman where it helps. Be
  polite but assertive; cite dates and the reference where known. Use [square-bracket placeholders]
  only where a fact is genuinely unknown.

Ground every claim in the context provided. Do not invent facts, dates, or promises. This is drafting
help, not legal advice — note any point the user should verify.

Return ONLY a single JSON object (no prose, no markdown fences) with exactly these keys:
{
  "summary": string,                     // 1-2 sentence situation analysis
  "recommended_action": string,          // the one next step, plainly stated
  "steps": [string],                     // 2-5 concrete next steps, most important first
  "email": { "subject": string, "body": string },  // ready-to-send draft
  "caution": string|null                 // anything to verify, or null
}`;

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Compact the timeline + emails into a readable block for the prompt.
function contextBlock({ complaint, rule, events, emails, extraContext, instruction }) {
  const lines = [];
  lines.push(`Organisation: ${complaint.org_name} (${rule.label})`);
  if (complaint.property) lines.push(`Property / account: ${complaint.property}`);
  if (complaint.reference) lines.push(`Their reference: ${complaint.reference}`);
  if (complaint.our_reference) lines.push(`Our reference: ${complaint.our_reference}`);
  lines.push(`Complaint reference: ${complaint.ref_code}`);
  lines.push(`Subject: ${complaint.subject}`);
  if (complaint.description) lines.push(`Description: ${complaint.description}`);
  lines.push(`Current stage: ${complaint.stage}`);
  lines.push(`Status: ${complaint.label}${complaint.overdue ? ' (OVERDUE)' : ''}`);
  lines.push(`Raised on: ${complaint.raised_on}`);
  if (complaint.acknowledged_on) lines.push(`Acknowledged on: ${complaint.acknowledged_on}`);
  lines.push(`Response due: ${complaint.response_due || 'n/a'}`);
  if (complaint.responded_on) lines.push(`Responded on: ${complaint.responded_on}`);
  lines.push(`Ombudsman referral by: ${complaint.ombudsman_deadline || 'n/a'}`);
  lines.push('');
  lines.push(`Their published procedure / legal basis: ${rule.legalBasis}`);
  lines.push(
    `Expected timescales — acknowledge ~${rule.ackDays} working days, Stage 1 ~${rule.stage1Days}, ` +
      `Stage 2 ~${rule.stage2Days}; escalate to ${rule.ombudsman} within ${rule.referralMonths} months.`,
  );
  if (complaint.nextAction) lines.push(`System-suggested next action: ${complaint.nextAction}`);

  lines.push('');
  lines.push('Timeline (most recent first):');
  if (events?.length) {
    for (const e of events) lines.push(`- ${e.event_date} [${e.type}] ${e.note || ''}`.trim());
  } else {
    lines.push('- (no events logged)');
  }

  lines.push('');
  lines.push('Emails logged against this complaint (most recent first):');
  if (emails?.length) {
    for (const em of emails) {
      const when = (em.received_at || '').slice(0, 10);
      lines.push(
        `- ${when} from ${em.sender_name || em.sender_email || 'unknown'} — ` +
          `"${em.subject || '(no subject)'}": ${(em.body_preview || '').slice(0, 500)}`,
      );
    }
  } else {
    lines.push('- (no emails logged yet)');
  }

  if (extraContext && extraContext.trim()) {
    lines.push('');
    lines.push('Additional information pasted by the user (emails, notes, letters):');
    lines.push(extraContext.trim());
  }

  lines.push('');
  if (instruction && instruction.trim()) {
    lines.push(`The user specifically asks: ${instruction.trim()}`);
  } else {
    lines.push(
      'No specific instruction — decide the most appropriate next action for this stage and status, ' +
        'and draft the email for it.',
    );
  }
  return lines.join('\n');
}

// Shared Claude call returning the concatenated text output.
async function callClaude({ system, user, maxTokens = 4000 }) {
  const anthropic = getClient();
  const res = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (res.stop_reason === 'refusal') {
    throw new HttpError(502, 'The assistant declined this request.');
  }
  return res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export async function assistComplaint(input) {
  const text = await callClaude({ system: SYSTEM, user: contextBlock(input) });
  const result = extractJson(text);
  if (!result || !result.email) {
    throw new HttpError(502, 'The assistant returned no usable draft. Try again or add more detail.');
  }
  return result;
}

// --- Deadlock / final-response detection -----------------------------------
const CLASSIFY_SYSTEM = `You assess a UK complaint's escalation status from its timeline and emails.
Decide whether the organisation has issued a FINAL response (often called a "final response",
"Stage 2 response", "our final decision", or a "deadlock letter"), and whether an 8-week deadlock
applies (energy/water especially). Then decide whether the complaint is now READY to escalate to the
relevant ombudsman/ADR scheme — either because their internal process is exhausted, or because they
have failed to respond within their statutory timescale (a handling failure that itself justifies
referral). Base this ONLY on the evidence given; do not assume.

Return ONLY a single JSON object with exactly these keys:
{
  "final_response": boolean,
  "deadlock": boolean,
  "ombudsman_ready": boolean,
  "reason": string,                 // one sentence, cite the evidence
  "suggested_next_stage": "stage_2"|"ombudsman"|"none"
}`;

export async function classifyComplaintStatus(input) {
  const text = await callClaude({
    system: CLASSIFY_SYSTEM,
    user: contextBlock({ ...input, instruction: 'Assess escalation status only.' }),
    maxTokens: 1500,
  });
  const result = extractJson(text);
  if (!result) throw new HttpError(502, 'Status check returned nothing usable.');
  return result;
}

// --- Ombudsman referral grounds --------------------------------------------
const GROUNDS_SYSTEM = `You draft the "grounds for referral" section of a UK ombudsman/ADR complaint
referral. Given the complaint history, write 2-4 tight paragraphs a caseworker can paste into the
ombudsman's form: what the complaint was, how the organisation handled it (with dates), where they
failed (missed deadlines are a handling failure), and what outcome is sought. UK business English,
factual, grounded in the evidence. Return PLAIN TEXT only (no JSON, no markdown headings).`;

export async function draftReferralGrounds(input) {
  return (await callClaude({
    system: GROUNDS_SYSTEM,
    user: contextBlock({ ...input, instruction: 'Write the grounds for referral.' }),
    maxTokens: 2000,
  })).trim();
}

// --- Import an existing complaint from a pasted thread ----------------------
const IMPORT_SYSTEM = `You extract a structured complaint record from pasted material (an email thread,
notes, or letters) about a complaint the user raised BEFORE using this system. Work out, from the
evidence: which organisation it's against and its type, what it's about, when it was first raised,
any reference numbers, whether it's been acknowledged and/or responded to, and therefore which stage
it's at now. Dates must be ISO YYYY-MM-DD; if a date is clearly implied but not exact, give your best
estimate and note it. If something isn't determinable, use null. Do NOT invent facts.

org_type must be one of: council, housing_association, water, energy, supplier, other.
stage must be one of: stage_1, stage_2, ombudsman.

Return ONLY a single JSON object with exactly these keys:
{
  "org_name": string|null,
  "org_type": "council"|"housing_association"|"water"|"energy"|"supplier"|"other",
  "subject": string,
  "category": string|null,
  "property": string|null,
  "reference": string|null,
  "our_reference": string|null,
  "channel": "email"|"phone"|"portal"|"letter"|"other",
  "raised_on": string|null,
  "acknowledged_on": string|null,
  "responded_on": string|null,
  "stage": "stage_1"|"stage_2"|"ombudsman",
  "description": string,
  "confidence": "high"|"medium"|"low",
  "notes": string
}`;

export async function parseImportedComplaint({ text, hint }) {
  const user =
    (hint ? `Hint from the user: ${hint}\n\n` : '') +
    `Pasted material about the existing complaint:\n\n${text}`;
  const out = await callClaude({ system: IMPORT_SYSTEM, user, maxTokens: 2000 });
  const result = extractJson(out);
  if (!result || !result.subject) {
    throw new HttpError(502, 'Could not extract a complaint from that. Add more detail and retry.');
  }
  return result;
}
