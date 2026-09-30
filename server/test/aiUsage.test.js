import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedSystem, costOf, priceFor, summarise } from '../src/services/aiUsage.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('a call is priced from its tokens at the model’s list price', () => {
  // Sonnet 5.5: $2 in, $10 out per million.
  near(costOf({ model: 'claude-sonnet-5-5', input_tokens: 1_000_000, output_tokens: 100_000 }).dollars, 3);
  // Web searches are $0.01 each on top.
  near(costOf({ model: 'claude-sonnet-5-5', input_tokens: 0, output_tokens: 0, web_searches: 6 }).dollars, 0.06);
  // Cache reads and writes at their own rates.
  near(costOf({ model: 'claude-opus-5-5', cache_read_tokens: 1_000_000, cache_write_tokens: 1_000_000 }).dollars, 5.2);
});

test('a dated model id finds its price; an unknown one is never shown as free', () => {
  assert.equal(priceFor('claude-sonnet-5-5-20260901').input, 2);
  assert.equal(priceFor('claude-sonnet-5').input, 2); // not mistaken for 5-5 or the reverse
  const c = costOf({ model: 'some-new-model', input_tokens: 1000 });
  assert.equal(c.priced, false);
});

test('a month adds up by feature, by day and in total', () => {
  const rows = [
    { feature: 'Standing AI review (automatic)', model: 'claude-sonnet-5-5', day: '2026-09-29', calls: 3, input_tokens: 300_000, output_tokens: 30_000, web_searches: 0 },
    { feature: 'Reading an incoming email', model: 'claude-sonnet-5-5', day: '2026-09-29', calls: 5, input_tokens: 50_000, output_tokens: 5_000, web_searches: 0 },
    { feature: 'Standing AI review (automatic)', model: 'claude-sonnet-5-5', day: '2026-09-30', calls: 1, input_tokens: 100_000, output_tokens: 10_000, web_searches: 0 },
  ];
  const s = summarise(rows);
  assert.equal(s.total.calls, 9);
  near(s.total.dollars, (450_000 * 2 + 45_000 * 10) / 1e6);
  assert.equal(s.by_feature[0].key, 'Standing AI review (automatic)'); // dearest first
  near(s.by_feature[0].dollars, (400_000 * 2 + 40_000 * 10) / 1e6);
  assert.deepEqual(s.by_day.map((d) => d.key), ['2026-09-29', '2026-09-30']);
});

test('a cached system prompt is the same words, marked for caching', () => {
  const s = cachedSystem('You read invoices.');
  assert.deepEqual(s, [{ type: 'text', text: 'You read invoices.', cache_control: { type: 'ephemeral' } }]);
  // The same text twice gives byte-identical blocks, so the second call reads the cache.
  assert.equal(JSON.stringify(cachedSystem('x')), JSON.stringify(cachedSystem('x')));
});
