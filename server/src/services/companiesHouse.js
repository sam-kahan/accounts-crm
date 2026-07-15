import { config } from '../config.js';
import { HttpError } from '../lib/http.js';

// ---------------------------------------------------------------------------
// Companies House Public Data API client.
// Docs: https://developer-specs.company-information.service.gov.uk/
// Auth: HTTP Basic with the API key as the username and an empty password.
// ---------------------------------------------------------------------------

const authHeader = () =>
  'Basic ' + Buffer.from(`${config.companiesHouse.apiKey}:`).toString('base64');

async function chFetch(path) {
  if (!config.companiesHouse.enabled) {
    throw new HttpError(
      503,
      'Companies House integration is not configured. Set COMPANIES_HOUSE_API_KEY in the server environment.',
    );
  }

  const url = `${config.companiesHouse.baseUrl}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: authHeader(), Accept: 'application/json' },
  });

  if (res.status === 404) {
    throw new HttpError(404, 'Company not found at Companies House');
  }
  if (res.status === 401) {
    throw new HttpError(502, 'Companies House rejected the API key (401)');
  }
  if (res.status === 429) {
    throw new HttpError(429, 'Companies House rate limit hit, try again shortly');
  }
  if (!res.ok) {
    throw new HttpError(502, `Companies House request failed (${res.status})`);
  }
  return res.json();
}

// Normalise a company number: uppercase, strip spaces, left-pad numeric-only to 8.
export function normaliseCompanyNumber(input) {
  const raw = String(input || '').toUpperCase().replace(/\s+/g, '');
  if (/^\d{1,8}$/.test(raw)) return raw.padStart(8, '0');
  return raw;
}

// Map a raw Companies House company profile into our shape + derived key dates.
export function mapProfile(profile) {
  const company = {
    name: profile.company_name,
    company_number: profile.company_number,
    status: profile.company_status || 'active',
    incorporation_date: profile.date_of_creation || null,
    accounts_next_due: profile.accounts?.next_due || null,
    confirmation_statement_next_due:
      profile.confirmation_statement?.next_due || null,
    registered_office: formatAddress(profile.registered_office_address),
    sic_codes: profile.sic_codes || [],
  };

  // Statutory key dates worth surfacing as reminders.
  const keyDates = [];
  if (profile.accounts?.next_due) {
    keyDates.push({
      category: 'accounts',
      title: 'Annual accounts due at Companies House',
      due_date: profile.accounts.next_due,
      recurrence: 'annual',
      source: 'companies_house',
    });
  }
  if (profile.confirmation_statement?.next_due) {
    keyDates.push({
      category: 'confirmation_statement',
      title: 'Confirmation statement due at Companies House',
      due_date: profile.confirmation_statement.next_due,
      recurrence: 'annual',
      source: 'companies_house',
    });
  }

  return { company, keyDates };
}

function formatAddress(a) {
  if (!a) return null;
  return [
    a.premises,
    a.address_line_1,
    a.address_line_2,
    a.locality,
    a.region,
    a.postal_code,
    a.country,
  ]
    .filter(Boolean)
    .join(', ');
}

// Fetch and map a company profile by (normalised) company number.
export async function getCompanyProfile(companyNumber) {
  const num = normaliseCompanyNumber(companyNumber);
  const profile = await chFetch(`/company/${encodeURIComponent(num)}`);
  return mapProfile(profile);
}

// Search companies by name/number (for the "add company" lookup box).
export async function searchCompanies(term) {
  const data = await chFetch(
    `/search/companies?q=${encodeURIComponent(term)}&items_per_page=10`,
  );
  return (data.items || []).map((item) => ({
    name: item.title,
    company_number: item.company_number,
    status: item.company_status,
    address: item.address_snippet,
  }));
}
