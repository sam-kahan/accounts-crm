// Thin fetch wrapper for the Accounts CRM API.
const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
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
    defaults: (type) => request(`/organisations/defaults/${type}`),
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
