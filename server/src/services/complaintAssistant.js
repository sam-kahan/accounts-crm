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

export async function assistComplaint(input) {
  const anthropic = getClient();
  const prompt = contextBlock(input);

  const res = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  if (res.stop_reason === 'refusal') {
    throw new HttpError(502, 'The assistant declined this request.');
  }

  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const result = extractJson(text);
  if (!result || !result.email) {
    throw new HttpError(502, 'The assistant returned no usable draft. Try again or add more detail.');
  }
  return result;
}
