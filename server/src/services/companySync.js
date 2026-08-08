import { pool, query } from '../db/pool.js';
import { getCompanyProfile } from './companiesHouse.js';
import { config } from '../config.js';

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
export async function upsertKeyDates(companyId, keyDates, client = { query }) {
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
                       THEN 'pending' ELSE key_dates.status END,
         completed_at = CASE WHEN key_dates.due_date IS DISTINCT FROM EXCLUDED.due_date
                             THEN NULL ELSE key_dates.completed_at END`,
      [companyId, kd.category, kd.title, kd.due_date, kd.recurrence],
    );
  }
}

// Write a mapped Companies House profile's fields onto an existing company row.
export async function applyProfile(client, id, company) {
  await client.query(
    `UPDATE companies SET
       name = $2, status = $3, incorporation_date = $4,
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
