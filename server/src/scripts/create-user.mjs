// Create (or reset the password of) a CRM login user.
// Self-contained: loads server/.env and talks to Postgres directly, so it works
// from any working directory.
//
// Usage (on the server, from the repo root):
//   node server/src/scripts/create-user.mjs <email> [full name]
//     -> generates a random password and prints it once
//   USER_PASSWORD='choose-your-own' node server/src/scripts/create-user.mjs <email> [full name]
//     -> uses the password you supply
// Re-running for an existing email resets that user's password.
import { config as loadEnv } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '../../.env') }); // server/.env

const email = process.argv[2];
const name = process.argv.slice(3).join(' ') || null;

if (!email) {
  console.error(
    'Usage: node server/src/scripts/create-user.mjs <email> [full name]\n' +
      '  Password: set USER_PASSWORD env, or one is generated and printed.',
  );
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not found in server/.env — aborting.');
  process.exit(1);
}

const password = process.env.USER_PASSWORD || randomBytes(9).toString('base64url');
const generated = !process.env.USER_PASSWORD;

const pool = new pg.Pool({ connectionString: url });
const hash = await bcrypt.hash(password, 12);

const { rows } = await pool.query(
  `INSERT INTO users (email, name, password_hash)
   VALUES (lower($1), $2, $3)
   ON CONFLICT (email) DO UPDATE
     SET password_hash = EXCLUDED.password_hash,
         name = COALESCE(EXCLUDED.name, users.name)
   RETURNING email, name, (xmax = 0) AS created`,
  [email, name, hash],
);
const u = rows[0];

console.log(
  `\n✅ ${u.created ? 'Created' : 'Updated'} user: ${u.email}${u.name ? ` (${u.name})` : ''}`,
);
if (generated) {
  console.log(`   Password: ${password}`);
  console.log("   ^ save this now — it won't be shown again.\n");
} else {
  console.log('   Password set from USER_PASSWORD.\n');
}

await pool.end();
