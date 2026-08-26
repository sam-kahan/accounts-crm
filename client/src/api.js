// Thin fetch wrapper for the Accounts CRM API.
const BASE = '/api';

async function request(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const res = await fetch(BASE + path, {
    // Let the browser set the multipart boundary for FormData uploads.
    headers: isForm ? undefined : { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  });
  // A 401 on any non-auth call means the session expired — tell the app to
  // drop back to the login screen.
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new Event('auth:unauthorized'));
  }
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.details = body.details;
    throw err;
  }
  return body;
}

// Drop empty filters so a blank search box doesn't become `?search=`.
function clean(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === '' || v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export const api = {
  health: () => request('/health'),

  auth: {
    me: () => request('/auth/me'),
    login: (email, password) =>
      request('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }),
    logout: () => request('/auth/logout', { method: 'POST' }),
    forgot: (email) =>
      request('/auth/forgot', {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),
    reset: (token, password) =>
      request('/auth/reset', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      }),
    changePassword: (current_password, new_password) =>
      request('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password, new_password }),
      }),
  },
  dashboard: (days = 30) => request(`/dashboard?days=${days}`),
  sendReminders: (days = 14) =>
    request('/dashboard/send-reminders', {
      method: 'POST',
      body: JSON.stringify({ days }),
    }),

  companies: {
    list: (search = '') =>
      request(`/companies${search ? `?search=${encodeURIComponent(search)}` : ''}`),
    get: (id) => request(`/companies/${id}`),
    create: (data) =>
      request('/companies', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) =>
      request(`/companies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id) => request(`/companies/${id}`, { method: 'DELETE' }),
    import: (companyNumber) =>
      request('/companies/import', {
        method: 'POST',
        body: JSON.stringify({ company_number: companyNumber }),
      }),
    sync: (id) => request(`/companies/${id}/sync`, { method: 'POST' }),
    syncAll: () => request('/companies/sync-all', { method: 'POST' }),
    // Companies House lookups
    chConfig: () => request('/companies/ch/config'),
    chSearch: (q) => request(`/companies/ch/search?q=${encodeURIComponent(q)}`),
    chProfile: (number) => request(`/companies/ch/${encodeURIComponent(number)}`),
  },

  keyDates: {
    list: (companyId) =>
      request(`/key-dates${companyId ? `?company_id=${companyId}` : ''}`),
    create: (data) =>
      request('/key-dates', { method: 'POST', body: JSON.stringify(data) }),
    complete: (id) => request(`/key-dates/${id}/complete`, { method: 'POST' }),
    remove: (id) => request(`/key-dates/${id}`, { method: 'DELETE' }),
  },

  tasks: {
    list: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/tasks${qs ? `?${qs}` : ''}`);
    },
    create: (data) =>
      request('/tasks', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) =>
      request(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id) => request(`/tasks/${id}`, { method: 'DELETE' }),
  },

  organisations: {
    list: () => request('/organisations'),
    get: (id) => request(`/organisations/${id}`),
    create: (data) =>
      request('/organisations', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) =>
      request(`/organisations/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id) => request(`/organisations/${id}`, { method: 'DELETE' }),
    researchConfig: () => request('/organisations/research/config'),
    research: (data) =>
      request('/organisations/research', { method: 'POST', body: JSON.stringify(data) }),
    researchAndCreate: (data) =>
      request('/organisations/research-and-create', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    defaults: (type) => request(`/organisations/defaults/${type}`),
  },

  users: {
    list: () => request('/users'),
    options: () => request('/users/access/options'),
    create: (data) => request('/users', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    invite: (id) => request(`/users/${id}/invite`, { method: 'POST' }),
    remove: (id) => request(`/users/${id}`, { method: 'DELETE' }),
  },

  contractors: {
    list: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/contractors${qs ? `?${qs}` : ''}`);
    },
    get: (id) => request(`/contractors/${id}`),
    defaults: () => request('/contractors/defaults'),
    create: (data) => request('/contractors', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) =>
      request(`/contractors/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id) => request(`/contractors/${id}`, { method: 'DELETE' }),
  },

  // Invoices received FROM contractors, each carrying commission for us.
  contractorInvoices: {
    list: (params = {}) => {
      const qs = new URLSearchParams(clean(params)).toString();
      return request(`/contractor-invoices${qs ? `?${qs}` : ''}`);
    },
    get: (id) => request(`/contractor-invoices/${id}`),
    // Multipart: the invoice document rides along with the fields.
    create: (fields, file) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(clean(fields))) fd.append(k, v);
      if (file) fd.append('file', file);
      return request('/contractor-invoices', { method: 'POST', body: fd });
    },
    update: (id, data) =>
      request(`/contractor-invoices/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    waive: (id, waived, reason) =>
      request(`/contractor-invoices/${id}/waive`, {
        method: 'POST',
        body: JSON.stringify({ waived, reason }),
      }),
    remove: (id) => request(`/contractor-invoices/${id}`, { method: 'DELETE' }),
    documentUrl: (id) => `/api/contractor-invoices/${id}/document`,
    summary: (params = {}) => {
      const qs = new URLSearchParams(clean(params)).toString();
      return request(`/contractor-invoices/summary${qs ? `?${qs}` : ''}`);
    },
    exportUrl: (params = {}) =>
      `/api/contractor-invoices/export.csv?${new URLSearchParams(clean(params)).toString()}`,
    aiConfig: () => request('/contractor-invoices/ai/config'),
    // Has this invoice been logged before? Asked while the form is being
    // filled in, so a duplicate is caught before the save is refused.
    duplicates: (params = {}) => {
      const qs = new URLSearchParams(clean(params)).toString();
      return request(`/contractor-invoices/duplicates${qs ? `?${qs}` : ''}`);
    },
    // Which office a property address belongs to, and why — the same answer the
    // save path will reach, so the form can show it before anyone presses save.
    region: (property) =>
      request(`/contractor-invoices/region?property=${encodeURIComponent(property || '')}`),
    // Read an uploaded invoice and hand back the fields it contains.
    extract: (file, contractorId) => {
      const fd = new FormData();
      fd.append('file', file);
      if (contractorId) fd.append('contractor_id', contractorId);
      return request('/contractor-invoices/extract', { method: 'POST', body: fd });
    },
  },

  // The invoices WE raise to contractors for the commission they collected.
  commissionInvoices: {
    list: (params = {}) => {
      const qs = new URLSearchParams(clean(params)).toString();
      return request(`/commission-invoices${qs ? `?${qs}` : ''}`);
    },
    get: (id) => request(`/commission-invoices/${id}`),
    settings: () => request('/commission-invoices/settings'),
    preview: (contractorId, params = {}) => {
      const qs = new URLSearchParams(clean(params)).toString();
      return request(`/commission-invoices/preview/${contractorId}${qs ? `?${qs}` : ''}`);
    },
    raise: (data) => request('/commission-invoices', { method: 'POST', body: JSON.stringify(data) }),
    send: (id, data = {}) =>
      request(`/commission-invoices/${id}/send`, { method: 'POST', body: JSON.stringify(data) }),
    // Send it to Greenco Invoicing, where it gets emailed and chased.
    push: (id) => request(`/commission-invoices/${id}/push`, { method: 'POST' }),
    // Read its state back from there (payment is recorded on that side).
    refresh: (id) => request(`/commission-invoices/${id}/refresh`, { method: 'POST' }),
    setStatus: (id, status, paidOn) =>
      request(`/commission-invoices/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status, paid_on: paidOn }),
      }),
    remove: (id) => request(`/commission-invoices/${id}`, { method: 'DELETE' }),
  },

  complaints: {
    dashboard: () => request('/complaints/dashboard'),
    list: (state = '') =>
      request(`/complaints${state ? `?state=${state}` : ''}`),
    get: (id) => request(`/complaints/${id}`),
    create: (data) =>
      request('/complaints', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) =>
      request(`/complaints/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id) => request(`/complaints/${id}`, { method: 'DELETE' }),
    addEvent: (id, data) =>
      request(`/complaints/${id}/events`, { method: 'POST', body: JSON.stringify(data) }),
    escalate: (id, date) =>
      request(`/complaints/${id}/escalate`, { method: 'POST', body: JSON.stringify({ date }) }),
    emailConfig: () => request('/complaints/email/config'),
    fetchEmails: () => request('/complaints/email/fetch', { method: 'POST' }),
    aiConfig: () => request('/complaints/ai/config'),
    assist: (id, data) =>
      request(`/complaints/${id}/assist`, { method: 'POST', body: JSON.stringify(data) }),
    sendEmail: (id, data) =>
      request(`/complaints/${id}/send-email`, { method: 'POST', body: JSON.stringify(data) }),
    checkStatus: (id) => request(`/complaints/${id}/check-status`, { method: 'POST' }),
    referralPack: (id) => request(`/complaints/${id}/referral-pack`),
    parseImport: (text, hint) =>
      request('/complaints/import/parse', { method: 'POST', body: JSON.stringify({ text, hint }) }),
    overdueDrafts: () => request('/complaints/chase/overdue', { method: 'POST' }),
    attachments: (id, files) => {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      return request(`/complaints/${id}/attachments`, { method: 'POST', body: fd });
    },
    attachmentUrl: (attId) => `/api/complaints/attachments/${attId}/download`,
    removeAttachment: (attId) =>
      request(`/complaints/attachments/${attId}`, { method: 'DELETE' }),
  },
};

export const ORG_TYPE_LABEL = {
  council: 'Council',
  housing_association: 'Housing association',
  water: 'Water supplier',
  energy: 'Energy supplier',
  supplier: 'Supplier',
  other: 'Other',
};

// --- shared date helpers ---------------------------------------------------
// Today's date as YYYY-MM-DD in UK local time. `toISOString().slice(0,10)` is
// the UTC date, which is a day ahead 00:00–01:00 during British Summer Time —
// wrong for date-only form defaults.
export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(
    new Date(),
  );
}

// £1,234.50 — money is always shown to the penny so a total can be checked
// against a bank statement at a glance.
export function formatMoney(value, { blankZero = false } = {}) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '—';
  if (blankZero && n === 0) return '—';
  return n.toLocaleString('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// The YYYY-MM month a date falls in; defaults to this month (UK local).
export function monthOf(dateStr) {
  return (dateStr || todayISO()).slice(0, 7);
}

// '2026-08' -> 'August 2026'
export function monthLabel(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) return month || '';
  return new Date(`${month}-01T00:00:00`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  });
}

export const COMMISSION_STATUS_LABEL = {
  pending: 'To invoice',
  invoiced: 'Invoiced',
  paid: 'Paid',
  waived: 'Waived',
};

export const INVOICE_STATUS_LABEL = {
  draft: 'Draft',
  sent: 'Sent',
  paid: 'Paid',
  void: 'Void',
};

// The two Greenco offices. Which one bills a job is worked out on the server
// from the site address on the contractor's invoice
// (server/src/services/regions.js) — these are only the names for it. The
// company each one invoices as comes from the server too (settings.regions),
// since it is configuration, not something the browser should assume.
export const REGIONS = [
  { key: 'manchester', label: 'Manchester' },
  { key: 'liverpool', label: 'Liverpool' },
];

export const REGION_LABEL = Object.fromEntries(REGIONS.map((r) => [r.key, r.label]));

export function formatDate(d) {
  if (!d) return '—';
  const date = new Date(d + (d.length === 10 ? 'T00:00:00' : ''));
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function daysUntil(d) {
  if (!d) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d + 'T00:00:00');
  return Math.round((target - today) / 86400000);
}

export function dueClass(d) {
  const n = daysUntil(d);
  if (n === null) return '';
  if (n < 0) return 'overdue';
  if (n <= 14) return 'soon';
  return '';
}
