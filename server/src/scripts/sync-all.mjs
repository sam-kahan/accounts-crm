// Re-sync every company from Companies House. Use this to backfill new key
// dates (e.g. the financial year end) onto companies that were imported before
// that feature existed.
//
// Usage (on the server, with the app running):
//   CRM_EMAIL=you@greenco.co.uk CRM_PASSWORD='...' node server/src/scripts/sync-all.mjs
//
const API = process.env.API_URL || 'http://localhost:4000';
let cookie = '';

// The session cookie is Secure in production. When we talk to the app directly
// over http://localhost (bypassing nginx), tell it the request arrived over
// https so it will issue the cookie. Safe: this runs locally on the same box.
const baseHeaders = {
  'Content-Type': 'application/json',
  'X-Forwarded-Proto': 'https',
};

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
      'Set your login, e.g.:\n' +
        "  CRM_EMAIL=you@greenco.co.uk CRM_PASSWORD='...' node server/src/scripts/sync-all.mjs",
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
  console.log(`Logged in as ${email}\n`);
}

async function main() {
  await login();
  const { status, body: companies } = await api('/api/companies');
  if (status !== 200 || !Array.isArray(companies)) {
    console.error(`Could not list companies (${status}).`);
    process.exit(1);
  }

  console.log(`Syncing ${companies.length} companies from Companies House\n`);
  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for (const c of companies) {
    if (!c.company_number) {
      console.log(`- ${c.name} — no company number, skipped`);
      skipped += 1;
      continue;
    }
    const r = await api(`/api/companies/${c.id}/sync`, { method: 'POST' });
    if (r.status === 200) {
      console.log(
        `✓ ${c.name} — year end ${r.body.accounts_next_made_up_to || '—'}, ` +
          `accounts due ${r.body.accounts_next_due || '—'}`,
      );
      synced += 1;
    } else {
      console.log(`✗ ${c.name} — sync failed (${r.status}): ${r.body.error || ''}`);
      failed += 1;
    }
  }

  console.log(`\nDone. Synced ${synced}, skipped ${skipped}, failed ${failed}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
