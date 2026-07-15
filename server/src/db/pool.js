import pg from 'pg';
import { config } from '../config.js';

// Companies House / statutory dates are plain calendar dates. Tell node-pg to
// hand DATE columns back as 'YYYY-MM-DD' strings rather than JS Date objects so
// we never shift a due date across a timezone boundary.
pg.types.setTypeParser(1082, (v) => v); // 1082 = DATE oid

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected idle Postgres client error', err);
});

export const query = (text, params) => pool.query(text, params);
