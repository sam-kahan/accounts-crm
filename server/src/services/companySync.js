import { pool, query } from '../db/pool.js';
import { getCompanyProfile } from './companiesHouse.js';
import { config } from '../config.js';
import { todayISO } from '../lib/dates.js';
import { ukDate } from './complaintRules.js';

// ---------------------------------------------------------------------------
// Keeping a company's statutory dates in step with Companies House.
//
// Companies House is the source of truth for accounts and confirmation
// statement filings. Once a filing is made, CH advances that item's next due
// date to the following period; re-syncing from CH is therefore how a filed
// item "drops off" the reminders without anyone marking it done by hand.
// ---------------------------------------------------------------------------

// Insert/update Companies-House-owned key dates in place (unique per category).
//
// Status handling is deliberate: only reset a date to 'pending' (and clear its
// completion) when the due date has actually MOVED — i.e. Companies House
// advanced it because the filing was made. That gives two behaviours from one
// rule:
//   * accounts / confirmation statement roll forward once filed and fall off
//     the overdue list automatically — no manual tick needed; and
//   * a date completed by hand (the financial year end is marked off manually)
//     stays done while its date is unchanged, yet a genuinely new period still
//     surfaces as a fresh reminder when CH advances the date.
// One more case reopens a date: the sync itself closed it because Companies
// House stopped giving it (syncCompany, below), and now gives it again (a
// company back from liquidation) — even at the same date. Only while that
// closing note is the last thing on it, so a date someone has since marked
// done by hand stays done.
const SYNC_CLOSED = 'Closed by the Companies House sync on [^[:cntrl:]]*$';
export async function upsertKeyDates(companyId, keyDates, client = { query }) {
  const reopened = `Given again by Companies House on ${ukDate(todayISO())}: reopened.`;
  for (const kd of keyDates) {
    await client.query(
      `INSERT INTO key_dates
         (company_id, category, title, due_date, recurrence, source)
       VALUES ($1,$2,$3,$4,$5,'companies_house')
       ON CONFLICT (company_id, category) WHERE (source = 'companies_house')
       DO UPDATE SET
         title = EXCLUDED.title,
         due_date = EXCLUDED.due_date,
         recurrence = EXCLUDED.recurrence,
         status = CASE WHEN key_dates.due_date IS DISTINCT FROM EXCLUDED.due_date
                         OR (key_dates.status = 'done' AND key_dates.notes ~ $6)
                       THEN 'pending' ELSE key_dates.status END,
         completed_at = CASE WHEN key_dates.due_date IS DISTINCT FROM EXCLUDED.due_date
                              OR (key_dates.status = 'done' AND key_dates.notes ~ $6)
                             THEN NULL ELSE key_dates.completed_at END,
         notes = CASE WHEN key_dates.status = 'done' AND key_dates.notes ~ $6
                      THEN concat_ws(E'\n', key_dates.notes, $7::text) ELSE key_dates.notes END`,
      [companyId, kd.category, kd.title, kd.due_date, kd.recurrence, SYNC_CLOSED, reopened],
    );
  }
}

// Write a mapped Companies House profile's fields onto an existing company row.
export async function applyProfile(client, id, company) {
  // A name Companies House gives differently is noted on the company, so a
  // mistyped number (another company's) or a renaming is seen, not silent.
  const { rows: [before] } = await client.query('SELECT name FROM companies WHERE id = $1', [id]);
  if (before && company.name && before.name.trim().toLowerCase() !== company.name.trim().toLowerCase()) {
    await client.query(
      `UPDATE companies SET notes = concat_ws(E'\n', NULLIF(notes, ''), $2::text) WHERE id = $1`,
      [id, `Name updated from Companies House on ${ukDate(todayISO())}: "${before.name}" is now "${company.name}". If this isn't the same company, check the company number.`],
    );
  }
  await client.query(
    `UPDATE companies SET
       -- Companies House never says "dormant": a company marked dormant here
       -- stays dormant while they call it active.
       name = $2, status = CASE WHEN status = 'dormant' AND $3 = 'active' THEN status ELSE $3 END,
       incorporation_date = $4,
       accounts_next_due = $5, confirmation_statement_next_due = $6,
       registered_office = $7, sic_codes = $8, accounts_next_made_up_to = $9,
       confirmation_statement_next_made_up_to = $10,
       ch_last_synced_at = now()
     WHERE id = $1`,
    [
      id,
      company.name,
      company.status,
      company.incorporation_date,
      company.accounts_next_due,
      company.confirmation_statement_next_due,
      company.registered_office,
      company.sic_codes,
      company.accounts_next_made_up_to,
      company.confirmation_statement_next_made_up_to,
    ],
  );
}

// Re-sync one company (by id + number) from Companies House, in a transaction.
export async function syncCompany(id, companyNumber) {
  const { company, keyDates } = await getCompanyProfile(companyNumber);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyProfile(client, id, company);
    await upsertKeyDates(id, keyDates, client);
    // A date Companies House no longer gives (a company in liquidation, say)
    // is closed with the reason, rather than left overdue for ever.
    await client.query(
      `UPDATE key_dates SET status = 'done', completed_at = now(),
              notes = concat_ws(E'\n', NULLIF(notes, ''), $3::text)
        WHERE company_id = $1 AND source = 'companies_house' AND status = 'pending'
          AND NOT (category = ANY($2::text[]))`,
      [id, keyDates.map((k) => k.category),
        `Closed by the Companies House sync on ${ukDate(todayISO())}: Companies House no longer gives this date.`],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Re-sync every company that has a Companies House number. Best-effort: one
// company's failure (a transient CH error, a 404 on a struck-off number) is
// recorded but doesn't abort the rest. Returns a summary for logging.
export async function syncAllCompanies() {
  if (!config.companiesHouse.enabled) {
    return { enabled: false, total: 0, synced: 0, failed: 0, failures: [] };
  }
  const { rows } = await query(
    `SELECT id, company_number FROM companies
       WHERE company_number IS NOT NULL AND company_number <> ''
         AND status <> 'dissolved'`,
  );
  let synced = 0;
  const failures = [];
  for (const c of rows) {
    try {
      await syncCompany(c.id, c.company_number);
      synced++;
    } catch (err) {
      failures.push({ id: c.id, company_number: c.company_number, error: err.message });
    }
  }
  return {
    enabled: true,
    total: rows.length,
    synced,
    failed: failures.length,
    failures,
  };
}
