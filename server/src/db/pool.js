import pg from 'pg';
import { config } from '../config.js';

// Companies House / statutory dates are plain calendar dates. Tell node-pg to
// hand DATE columns back as 'YYYY-MM-DD' strings rather than JS Date objects so
// we never shift a due date across a timezone boundary.
pg.types.setTypeParser(1082, (v) => v); // 1082 = DATE oid

// A connection that can't be made within 10s fails rather than hanging (the
// deploy's wait-for-imports step must never hold a deploy up on it).
export const pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 10000 });

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected idle Postgres client error', err);
});

export const query = (text, params) => pool.query(text, params);
