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

// The profile is model output derived from arbitrary web pages, and it is
// auto-persisted (research-and-create) — so coerce/clamp every field to a known
// shape and drop anything malformed rather than trusting it verbatim.
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
function cleanStr(v, max) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}
function cleanUrl(v) {
  const s = cleanStr(v, 2000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}
function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
}
function normaliseProfile(p) {
  const email = cleanStr(p.complaints_email, 320);
  return {
    complaints_email: email && EMAIL_RE.test(email) ? email : null,
    complaints_url: cleanUrl(p.complaints_url),
    phone: cleanStr(p.phone, 64),
    ombudsman_name: cleanStr(p.ombudsman_name, 200),
    ombudsman_url: cleanUrl(p.ombudsman_url),
    ombudsman_referral_months: clampInt(p.ombudsman_referral_months, 0, 120),
    stage1_response_days: clampInt(p.stage1_response_days, 0, 400),
    stage2_response_days: clampInt(p.stage2_response_days, 0, 400),
    ack_days: clampInt(p.ack_days, 0, 400),
    procedure_summary: cleanStr(p.procedure_summary, 8000) || '',
    legal_basis: cleanStr(p.legal_basis, 8000) || '',
    sources: Array.isArray(p.sources)
      ? p.sources
          .map((s) => ({ title: cleanStr(s?.title, 300) || '', url: cleanUrl(s?.url) }))
          .filter((s) => s.url)
          .slice(0, 20)
      : [],
  };
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

  const messages = [{ role: 'user', content: prompt }];
  let res;
  // The web-search server tool runs a server-side loop; if it hits its
  // iteration cap it returns stop_reason 'pause_turn' and must be resumed by
  // re-sending the conversation. Loop a few times until it finishes.
  for (let i = 0; i < 4; i += 1) {
    res = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: SYSTEM,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
      messages,
    });
    if (res.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: res.content });
  }

  if (res.stop_reason === 'refusal') {
    throw new HttpError(502, 'Research request was declined.');
  }

  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const profile = extractJson(text);
  if (!profile) {
    throw new HttpError(502, 'Research completed but returned no usable profile.');
  }
  return normaliseProfile(profile);
}
