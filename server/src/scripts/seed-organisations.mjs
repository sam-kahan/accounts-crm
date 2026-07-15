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

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { ...baseHeaders, ...(cookie ? { Cookie: cookie } : {}) },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
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

  let researched = 0, created = 0, skipped = 0, failed = 0;
  for (const p of PROVIDERS) {
    if (existing.has(p.name.toLowerCase())) {
      console.log(`• ${p.name} — already present, skipped`);
      skipped += 1;
      continue;
    }

    if (canResearch) {
      const r = await api('/api/organisations/research-and-create', {
        method: 'POST',
        body: JSON.stringify(p),
      });
      if (r.status === 201 || r.status === 200) {
        console.log(`✓ ${p.name} — researched (${r.body.ombudsman_name || 'procedure set'})`);
        researched += 1;
        continue;
      }
      console.log(`  ${p.name} — research failed (${r.status}), creating with defaults`);
    }

    // Plain create (no research, or research failed).
    const c = await api('/api/organisations', {
      method: 'POST',
      body: JSON.stringify({ ...p, research_status: 'none' }),
    });
    if (c.status === 201) {
      console.log(`✓ ${p.name} — created (${p.type} defaults)`);
      created += 1;
    } else {
      console.log(`✗ ${p.name} — failed (${c.status}): ${c.body.error || ''}`);
      failed += 1;
    }
  }

  console.log(
    `\nDone. Researched ${researched}, created ${created}, skipped ${skipped}, failed ${failed}.`,
  );
  if (!canResearch && created > 0) {
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
