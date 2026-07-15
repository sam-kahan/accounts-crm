// Bulk-import companies into the CRM from a list of names / numbers.
//
// Runs against the LOCAL running API (so it uses the server's Companies House
// key and DB). Each line is either a company NAME (searched on Companies House,
// best active exact match imported) or an 8-char company NUMBER (imported
// directly). Already-present companies are skipped.
//
// Usage (on the server, from the repo root, with the app running):
//   node server/src/scripts/bulk-import.mjs                     # uses companies.txt beside this file
//   node server/src/scripts/bulk-import.mjs path/to/list.txt    # custom list
//   API_URL=http://localhost:4000 node server/src/scripts/bulk-import.mjs
//
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API = process.env.API_URL || 'http://localhost:4000';

const norm = (s) =>
  s.toUpperCase().replace(/\bLIMITED\b/g, 'LTD').replace(/[^A-Z0-9]/g, '');
const isNumber = (s) => /^[A-Z0-9]{8}$/i.test(s.replace(/\s/g, ''));

let cookie = '';

// Tell the app the request arrived over https so it issues the Secure session
// cookie even when we hit http://localhost directly (bypassing nginx).
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

// The API requires a login session. Authenticate with CRM_EMAIL / CRM_PASSWORD.
async function login() {
  const email = process.env.CRM_EMAIL;
  const password = process.env.CRM_PASSWORD;
  if (!email || !password) {
    console.error(
      'This CRM requires login. Re-run with your credentials, e.g.:\n' +
        "  CRM_EMAIL=you@greenco.co.uk CRM_PASSWORD='...' node server/src/scripts/bulk-import.mjs",
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

async function resolveNumber(name) {
  const { status, body } = await api(
    `/api/companies/ch/search?q=${encodeURIComponent(name)}`,
  );
  if (status !== 200 || !Array.isArray(body)) return { error: `search failed (${status})` };
  const exact = body.filter((i) => norm(i.name) === norm(name));
  const active = exact.filter((i) => i.status === 'active');
  const chosen = active[0] || exact[0];
  if (!chosen) return { error: 'no exact match on Companies House' };
  return {
    number: chosen.company_number,
    official: chosen.name,
    ch_status: chosen.status,
    ambiguous: active.length > 1 || (active.length === 0 && exact.length > 1),
  };
}

async function main() {
  const listPath = process.argv[2]
    ? resolve(process.argv[2])
    : join(__dirname, 'companies.txt');
  const raw = await readFile(listPath, 'utf8');
  const entries = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  await login();

  console.log(`Importing ${entries.length} companies via ${API}\n`);
  const summary = { imported: 0, exists: 0, notfound: 0, failed: 0 };

  for (const entry of entries) {
    let number = isNumber(entry) ? entry.replace(/\s/g, '') : null;
    let label = entry;

    if (!number) {
      const r = await resolveNumber(entry);
      if (r.error) {
        console.log(`✗ ${entry.padEnd(38)} — ${r.error}`);
        summary.notfound += 1;
        continue;
      }
      number = r.number;
      label = `${entry.padEnd(38)} → ${number} (${r.ch_status})${r.ambiguous ? ' ⚠ multiple matches' : ''}`;
    }

    const { status, body } = await api('/api/companies/import', {
      method: 'POST',
      body: JSON.stringify({ company_number: number }),
    });

    if (status === 201) {
      console.log(`✓ ${label}`);
      summary.imported += 1;
    } else if (status === 409) {
      console.log(`• ${label} — already in CRM`);
      summary.exists += 1;
    } else if (status === 404) {
      console.log(`✗ ${label} — not found at Companies House`);
      summary.notfound += 1;
    } else {
      console.log(`✗ ${label} — import failed (${status}): ${body.error || ''}`);
      summary.failed += 1;
    }
  }

  console.log(
    `\nDone. Imported ${summary.imported}, already present ${summary.exists}, ` +
      `not found ${summary.notfound}, failed ${summary.failed}.`,
  );
  if (summary.notfound || summary.failed) {
    console.log(
      'Review any ✗ rows — you can add those manually in the app (they may be ' +
        'a slightly different registered name, or not on the public register).',
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
