import { query } from '../db/pool.js';

// ---------------------------------------------------------------------------
// AI spend, recorded per call and priced when read. The owner watches the
// Anthropic bill, so every call says what it was for (`feature`) and what it
// used; Admin → AI usage adds it up by month, feature and day. The figures are
// ESTIMATES from list prices in US dollars (Anthropic bills in dollars): the
// invoice from Anthropic is the authority.
// ---------------------------------------------------------------------------

// US dollars per million tokens (Anthropic's published first-party prices);
// cache writes are 1.25x input. Web search is per request.
export const PRICES = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};
export const WEB_SEARCH_DOLLARS = 0.01; // $10 per 1,000 searches

// The price list for a model id, allowing for a dated or suffixed id; an
// unknown model is priced as the dearest listed Sonnet/Opus it resembles, or
// null (shown as "price unknown", never as free).
export function priceFor(model) {
  const m = String(model || '').toLowerCase();
  const key = Object.keys(PRICES).sort((a, b) => b.length - a.length).find((k) => m.startsWith(k));
  return key ? PRICES[key] : null;
}

// Estimated dollars for one row (or a sum of rows of one model).
export function costOf(r) {
  const p = priceFor(r.model);
  const search = (Number(r.web_searches) || 0) * WEB_SEARCH_DOLLARS;
  if (!p) return { dollars: search, priced: false };
  const tokens =
    (Number(r.input_tokens) || 0) * p.input +
    (Number(r.output_tokens) || 0) * p.output +
    (Number(r.cache_read_tokens) || 0) * p.cacheRead +
    (Number(r.cache_write_tokens) || 0) * p.cacheWrite;
  return { dollars: tokens / 1e6 + search, priced: true };
}

// Record what a Messages API response used. Best-effort: a failure to record
// never fails the work the call was for.
export async function recordUsage(feature, res) {
  try {
    const u = res?.usage;
    if (!u) return;
    await query(
      `INSERT INTO ai_usage (feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, web_searches)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        String(feature || 'Other').slice(0, 80), res.model || null,
        u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0,
        u.cache_creation_input_tokens || 0, u.server_tool_use?.web_search_requests || 0,
      ],
    );
  } catch (err) {
    console.error('[ai-usage] not recorded:', err.message);
  }
}

// `await track('Invoice reading', client.messages.create({...}))`: the
// response, recorded on the way through.
export async function track(feature, pending) {
  const res = await pending;
  await recordUsage(feature, res);
  return res;
}

// A month's spend (YYYY-MM, UK months): totals, by feature, by day, and the
// last 12 months for comparison.
export async function usageFor(month) {
  const from = `${month}-01`;
  const rows = (await query(
    `SELECT feature, model, (at AT TIME ZONE 'Europe/London')::date::text AS day, count(*)::int AS calls,
            sum(input_tokens)::bigint AS input_tokens, sum(output_tokens)::bigint AS output_tokens,
            sum(cache_read_tokens)::bigint AS cache_read_tokens, sum(cache_write_tokens)::bigint AS cache_write_tokens,
            sum(web_searches)::int AS web_searches
       FROM ai_usage
      WHERE (at AT TIME ZONE 'Europe/London') >= $1::date
        AND (at AT TIME ZONE 'Europe/London') < ($1::date + interval '1 month')
      GROUP BY 1, 2, 3`,
    [from],
  )).rows;
  const months = (await query(
    `SELECT to_char(at AT TIME ZONE 'Europe/London', 'YYYY-MM') AS month, model, count(*)::int AS calls,
            sum(input_tokens)::bigint AS input_tokens, sum(output_tokens)::bigint AS output_tokens,
            sum(cache_read_tokens)::bigint AS cache_read_tokens, sum(cache_write_tokens)::bigint AS cache_write_tokens,
            sum(web_searches)::int AS web_searches
       FROM ai_usage
      WHERE at >= (date_trunc('month', now() AT TIME ZONE 'Europe/London') - interval '11 months')
      GROUP BY 1, 2`,
  )).rows;
  return summarise(rows, months);
}

// Pure: rows of (feature, model, day, sums) → the page's figures.
export function summarise(rows, months = []) {
  const add = (map, key, r) => {
    const cur = map.get(key) || { key, calls: 0, input_tokens: 0, output_tokens: 0, web_searches: 0, dollars: 0, unpriced: false };
    const c = costOf(r);
    cur.calls += Number(r.calls) || 0;
    cur.input_tokens += Number(r.input_tokens) || 0;
    cur.output_tokens += Number(r.output_tokens) || 0;
    cur.web_searches += Number(r.web_searches) || 0;
    cur.dollars += c.dollars;
    cur.unpriced = cur.unpriced || !c.priced;
    map.set(key, cur);
  };
  const byFeature = new Map();
  const byDay = new Map();
  const total = new Map();
  for (const r of rows) {
    add(byFeature, r.feature, r);
    add(byDay, r.day, r);
    add(total, 'all', r);
  }
  const byMonth = new Map();
  for (const r of months) add(byMonth, r.month, r);
  return {
    total: total.get('all') || { calls: 0, input_tokens: 0, output_tokens: 0, web_searches: 0, dollars: 0, unpriced: false },
    by_feature: [...byFeature.values()].sort((a, b) => b.dollars - a.dollars),
    by_day: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    by_month: [...byMonth.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}
