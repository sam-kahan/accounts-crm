import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { ruleFor } from './complaintRules.js';

// ---------------------------------------------------------------------------
// Research a specific organisation's complaints procedure using Claude with web
// search. Returns a structured profile (ombudsman, timescales, procedure, legal
// basis, sources) that pre-fills the organisation record for the user to review.
// Gated on ANTHROPIC_API_KEY; when unset, callers fall back to type defaults.
// ---------------------------------------------------------------------------

let client = null;
function getClient() {
  if (!config.anthropic.enabled) {
    throw new HttpError(
      503,
      'AI research is not configured. Set ANTHROPIC_API_KEY in the server environment.',
    );
  }
  if (!client) client = new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

const SYSTEM = `You are a UK complaints-procedure researcher for a property/accounts team.
Given an organisation (a council, housing association, water/energy supplier, or other supplier),
use web search to find how to complain to THAT specific organisation and the legal framework and
deadlines that apply. Prioritise the organisation's own official complaints page and the relevant
ombudsman/regulator. Be accurate and cite sources. If you cannot confirm a specific value, use the
sensible sector default and say so in the notes. Timescales are in WORKING DAYS.

Return ONLY a single JSON object (no prose, no markdown fences) with exactly these keys:
{
  "complaints_email": string|null,
  "complaints_url": string|null,
  "phone": string|null,
  "ombudsman_name": string|null,
  "ombudsman_url": string|null,
  "ombudsman_referral_months": number|null,
  "stage1_response_days": number|null,
  "stage2_response_days": number|null,
  "ack_days": number|null,
  "procedure_summary": string,
  "legal_basis": string,
  "sources": [{"title": string, "url": string}]
}`;

// Extract the last JSON object from the model's text output.
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

export async function researchOrganisation({ name, type, location }) {
  const anthropic = getClient();
  const fallback = ruleFor(type);

  const prompt = `Organisation: ${name}
Type: ${type}${location ? `\nLocation / area: ${location}` : ''}

Research this organisation's complaints procedure and the applicable UK legal framework.
For reference, the typical sector defaults for a ${fallback.label} are: acknowledge within
${fallback.ackDays} working days, Stage 1 response within ${fallback.stage1Days} working days,
Stage 2 within ${fallback.stage2Days} working days, escalate to ${fallback.ombudsman} within
${fallback.referralMonths} months. Confirm or correct these for THIS organisation.`;

  const res = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system: SYSTEM,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
    messages: [{ role: 'user', content: prompt }],
  });

  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const profile = extractJson(text);
  if (!profile) {
    throw new HttpError(502, 'Research completed but returned no usable profile.');
  }
  return profile;
}
