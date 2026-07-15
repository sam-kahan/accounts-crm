// Seed the organisations you complain to. For each provider:
//   - if AI research is configured (ANTHROPIC_API_KEY), research + tailor it
//   - otherwise create it with the correct per-type legal defaults
// Existing organisations (by name) are skipped, so this is safe to re-run.
//
// Usage (on the server, app running):
//   CRM_EMAIL=you@greenco.co.uk CRM_PASSWORD='...' node server/src/scripts/seed-organisations.mjs
//
const API = process.env.API_URL || 'http://localhost:4000';
let cookie = '';
const baseHeaders = { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' };

// Greenco's providers.
const PROVIDERS = [
  { name: 'Manchester City Council', type: 'council', location: 'Manchester' },
  { name: 'Salford City Council', type: 'council', location: 'Salford' },
  { name: 'Tameside Metropolitan Borough Council', type: 'council', location: 'Tameside' },
  { name: 'Warrington Borough Council', type: 'council', location: 'Warrington' },
  { name: 'Bury Council', type: 'council', location: 'Bury' },
  { name: 'Liverpool City Council', type: 'council', location: 'Liverpool' },
  { name: 'Wigan Council', type: 'council', location: 'Wigan' },
  { name: 'Wirral Council', type: 'council', location: 'Wirral' },
  { name: 'Stockport Metropolitan Borough Council', type: 'council', location: 'Stockport' },
  { name: 'Halton Borough Council', type: 'council', location: 'Halton (Runcorn & Widnes)' },
  { name: 'British Gas', type: 'energy' },
  { name: 'E.ON Next', type: 'energy' },
  { name: 'Scottish Power', type: 'energy' },
  { name: 'Utility Warehouse', type: 'energy' },
  { name: 'Utilita', type: 'energy' },
];

async function api(path, options = {}, timeoutMs = 0) {
  const ctrl = timeoutMs ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(API + path, {
      headers: { ...baseHeaders, ...(cookie ? { Cookie: cookie } : {}) },
      signal: ctrl?.signal,
      ...options,
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: { error: e.name === 'AbortError' ? 'timed out' : e.message } };
  } finally {
    if (t) clearTimeout(t);
  }
}

// Run `worker` over items with limited concurrency.
async function runPool(items, size, worker) {
  const queue = items.map((item, i) => ({ item, i }));
  async function next() {
    while (queue.length) {
      const { item, i } = queue.shift();
      await worker(item, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, next));
}

async function login() {
  const email = process.env.CRM_EMAIL;
  const password = process.env.CRM_PASSWORD;
  if (!email || !password) {
    console.error(
      "Set your login, e.g.:\n  CRM_EMAIL=you@greenco.co.uk CRM_PASSWORD='...' node server/src/scripts/seed-organisations.mjs",
    );
    process.exit(1);
  }
  const res = await fetch(API + '/api/auth/login', {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    console.error(`Login failed (${res.status}) for ${email}.`);
    process.exit(1);
  }
  const set = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  cookie = set.map((c) => c.split(';')[0]).join('; ');
}

async function main() {
  await login();

  const cfg = await api('/api/organisations/research/config');
  const canResearch = cfg.body?.enabled;
  console.log(
    canResearch
      ? 'AI research is ON — each provider will be researched and tailored (this takes a few seconds each).\n'
      : 'AI research is OFF — providers will be created with per-type defaults. Set ANTHROPIC_API_KEY and re-run to tailor them.\n',
  );

  const existing = new Set(
    (await api('/api/organisations')).body.map((o) => o.name.toLowerCase()),
  );

  const todo = PROVIDERS.filter((p) => !existing.has(p.name.toLowerCase()));
  const already = PROVIDERS.length - todo.length;
  if (already) console.log(`${already} already present — skipping those.`);
  if (canResearch && todo.length) {
    console.log(`Researching ${todo.length} providers (up to 4 at a time)…\n`);
  }

  const stats = { researched: 0, created: 0, failed: 0 };
  const CONCURRENCY = canResearch ? 4 : 8;

  await runPool(todo, CONCURRENCY, async (p) => {
    if (canResearch) {
      console.log(`  → researching ${p.name}…`);
      // 3-minute ceiling per provider so one slow search can't stall the batch.
      const r = await api(
        '/api/organisations/research-and-create',
        { method: 'POST', body: JSON.stringify(p) },
        180000,
      );
      if (r.status === 201 || r.status === 200) {
        console.log(`✓ ${p.name} — researched (${r.body.ombudsman_name || 'procedure set'})`);
        stats.researched += 1;
        return;
      }
      console.log(`  ${p.name} — research ${r.body.error || 'failed'} (${r.status}); using defaults`);
    }
    const c = await api('/api/organisations', {
      method: 'POST',
      body: JSON.stringify({ ...p, research_status: 'none' }),
    });
    if (c.status === 201) {
      console.log(`✓ ${p.name} — created (${p.type} defaults)`);
      stats.created += 1;
    } else {
      console.log(`✗ ${p.name} — failed (${c.status}): ${c.body.error || ''}`);
      stats.failed += 1;
    }
  });

  console.log(
    `\nDone. Researched ${stats.researched}, created ${stats.created}, ` +
      `skipped ${already}, failed ${stats.failed}.`,
  );
  if (!canResearch && stats.created > 0) {
    console.log(
      'Tip: set ANTHROPIC_API_KEY on the server, then open each organisation and click ' +
        '“Research procedure” to tailor its deadlines — or re-run this after deleting them.',
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
