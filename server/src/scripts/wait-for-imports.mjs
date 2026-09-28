// Run by deploy/deploy.sh just before the restart. A restart part-way through
// an import stops it (it is picked up again afterwards, but the work done so
// far is lost and paid for twice), so a deploy waits for any import in
// progress to finish, for up to 10 minutes. Automatic import is paused for the
// wait, so a new one doesn't start in the meantime; the restarted server lifts
// the pause at start-up (and it lapses on its own after 15 minutes).
//
//   node src/scripts/wait-for-imports.mjs
//
// Never fails the deploy: any problem here just means restarting now.
import { config as loadEnv } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '../../.env') });

const { query, pool } = await import('../db/pool.js');
const { setSetting } = await import('../services/settings.js');

const MAX_WAIT_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

try {
  await setSetting('imports_paused', { until: new Date(Date.now() + 15 * 60 * 1000).toISOString(), why: 'deploy' }, 'deploy');
  const started = Date.now();
  for (;;) {
    const n = (await query(`SELECT count(*)::int AS n FROM complaint_import_candidates WHERE status = 'importing'`)).rows[0].n;
    if (!n) {
      console.log(`[${ts()}] accounts-crm: no import in progress`);
      break;
    }
    if (Date.now() - started > MAX_WAIT_MS) {
      console.log(`[${ts()}] accounts-crm: ${n} import(s) still running after 10 minutes; restarting anyway (they are picked up again)`);
      break;
    }
    console.log(`[${ts()}] accounts-crm: waiting for ${n} import(s) to finish before restarting`);
    await sleep(15000);
  }
} catch (err) {
  console.log(`[${ts()}] accounts-crm: couldn't check for imports (${err.message}); restarting now`);
} finally {
  await pool.end().catch(() => {});
}
