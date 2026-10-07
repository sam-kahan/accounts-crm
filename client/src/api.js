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
    saveSignature: (details) =>
      request('/auth/me/signature', { method: 'PUT', body: JSON.stringify(details) }),
    previewSignature: (details) =>
      request('/auth/me/signature/preview', { method: 'POST', body: JSON.stringify(details) }),
  },
  dashboard: (days = 30) => request(`/dashboard?days=${days}`),
  sendReminders: (days = 14) =>
    request('/dashboard/send-reminders', {
      method: 'POST',
      body: JSON.stringify({ days }),
    }),
  remindersRun: () => request('/dashboard/reminders-run'),

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
    // The date being marked done, so a second press can't roll it on twice.
    complete: (id, dueDate) =>
      request(`/key-dates/${id}/complete`, { method: 'POST', body: JSON.stringify({ due_date: dueDate || null }) }),
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

  // The ombudsman register: each scheme's rules, sources and who checked them.
  ombudsmen: {
    list: () => request('/ombudsmen'),
    update: (id, data) => request(`/ombudsmen/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
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
    // Read their own procedure document; returns values to check, saves nothing.
    readProcedure: (file, { name, type } = {}) => {
      const fd = new FormData();
      fd.append('file', file);
      if (name) fd.append('name', name);
      if (type) fd.append('type', type);
      return request('/organisations/procedure/read', { method: 'POST', body: fd });
    },
    documents: (id) => request(`/organisations/${id}/documents`),
    uploadDocuments: (id, files) => {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      return request(`/organisations/${id}/documents`, { method: 'POST', body: fd });
    },
    documentUrl: (docId) => `/api/organisations/documents/${docId}/download`,
    removeDocument: (docId) =>
      request(`/organisations/documents/${docId}`, { method: 'DELETE' }),
  },

  // The top bar's search: every section the viewer may see.
  search: (q) => request(`/search?q=${encodeURIComponent(q)}`),

  // Admin → AI usage: what the AI has cost, by month (YYYY-MM).
  aiUsage: (month) => request(`/ai-usage${month ? `?month=${month}` : ''}`),

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
    // Swap the stored document for another (the wrong file went up) — pending
    // lines only, like Amend.
    replaceDocument: (id, file) => {
      const fd = new FormData();
      fd.append('file', file);
      return request(`/contractor-invoices/${id}/document`, { method: 'POST', body: fd });
    },
    documentUrl: (id) => `/api/contractor-invoices/${id}/document`,
    summary: (params = {}) => {
      const qs = new URLSearchParams(clean(params)).toString();
      return request(`/contractor-invoices/summary${qs ? `?${qs}` : ''}`);
    },
    exportUrl: (params = {}) =>
      `/api/contractor-invoices/export.csv?${new URLSearchParams(clean(params)).toString()}`,
    // Earlier months that still have commission to invoice — the "did we miss
    // one?" check.
    outstanding: (params = {}) => {
      const qs = new URLSearchParams(clean(params)).toString();
      return request(`/contractor-invoices/outstanding${qs ? `?${qs}` : ''}`);
    },
    aiConfig: () => request('/contractor-invoices/ai/config'),
    // Has this invoice been logged before? Asked while the form is being
    // filled in, so a duplicate is caught before the save is refused.
    duplicates: (params = {}) => {
      const qs = new URLSearchParams(clean(params)).toString();
      return request(`/contractor-invoices/duplicates${qs ? `?${qs}` : ''}`);
    },
    // Which office a property address belongs to, and why — the same answer the
    // save path will reach, so the form can show it before anyone presses save.
    // Which office an address belongs to, and why. The contractor matters: an
    // address that can't be placed falls back to their usual office, so the
    // preview has to ask the same question the save will.
    region: (property, contractorId) =>
      request(
        `/contractor-invoices/region?property=${encodeURIComponent(property || '')}${
          contractorId ? `&contractor_id=${encodeURIComponent(contractorId)}` : ''
        }`,
      ),
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
    setStatus: (id, status, paidOn, reason) =>
      request(`/commission-invoices/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status, paid_on: paidOn, reason: reason || null }),
      }),
    // Withdraw a voided invoice over there, so the contractor stops being
    // chased for it. The void does this itself; this is the retry.
    withdraw: (id, reason) =>
      request(`/commission-invoices/${id}/withdraw`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason || null }),
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
    // partyId: a further organisation on the complaint (null: the main one).
    // `to: 'ombudsman'` records a referral from either stage (not one stage up).
    // The Stage 2 request the page found in our emails: escalated from its date, with Undo on that email.
    confirmStage2Email: (id, emailId) => request(`/complaints/${id}/stage2-missed/${emailId}`, { method: 'POST' }),
    escalate: (id, date, partyId = null, to = null) =>
      request(`/complaints/${id}/escalate`, { method: 'POST', body: JSON.stringify({ date, party_id: partyId, to }) }),
    // Say what an email that arrived was: acknowledgement | response | correspondence,
    // and, with more than one organisation on the complaint, which one it is from.
    reviewEmail: (id, emailId, as, date, partyId = null) =>
      request(`/complaints/${id}/emails/${emailId}/review`, {
        method: 'POST',
        body: JSON.stringify({ as, date: date || null, party_id: partyId }),
      }),
    // Raise it with the supplier a debt collector is acting for: an AI draft,
    // then send it from here (or record it sent from Outlook) and join them on.
    // Making it a formal complaint (the emails show none was made): the AI's draft, then sent or recorded.
    // Take the main organisation off; the next one (or the one given) takes its place.
    removeMain: (id, promotePartyId = null) =>
      request(`/complaints/${id}/main/remove`, { method: 'POST', body: JSON.stringify({ promote_party_id: promotePartyId }) }),
    formalDraft: (id) => request(`/complaints/${id}/formal/draft`, { method: 'POST' }),
    formalRaise: (id, data) => request(`/complaints/${id}/formal/raise`, { method: 'POST', body: JSON.stringify(data) }),
    supplierDecline: (id, name) =>
      request(`/complaints/${id}/supplier/decline`, { method: 'POST', body: JSON.stringify({ name }) }),
    supplierDraft: (id, data) =>
      request(`/complaints/${id}/supplier/draft`, { method: 'POST', body: JSON.stringify(data) }),
    supplierRaise: (id, data) =>
      request(`/complaints/${id}/supplier/raise`, { method: 'POST', body: JSON.stringify(data) }),
    // Further organisations on one complaint (a debt collector and the supplier).
    addParty: (id, data) =>
      request(`/complaints/${id}/parties`, { method: 'POST', body: JSON.stringify(data) }),
    updateParty: (id, partyId, data) =>
      request(`/complaints/${id}/parties/${partyId}`, { method: 'PUT', body: JSON.stringify(data) }),
    removeParty: (id, partyId) =>
      request(`/complaints/${id}/parties/${partyId}`, { method: 'DELETE' }),
    // "Looks resolved" answered no.
    notResolved: (id, note) =>
      request(`/complaints/${id}/resolution-suggestion/dismiss`, { method: 'POST', body: JSON.stringify({ note: note || null }) }),
    // Re-check complaints against their emails: every open one, or one now.
    recheckStatus: () => request('/complaints/recheck'),
    recheckAll: (force = false, onlyNever = false) => request('/complaints/recheck', { method: 'POST', body: JSON.stringify({ force, only_never: onlyNever }) }),
    recheck: (id) => request(`/complaints/${id}/recheck`, { method: 'POST' }),
    undoRecheck: (id) => request(`/complaints/${id}/recheck/undo`, { method: 'POST' }),
    // Emails that bounced, not yet looked into; and saying one has been.
    bounces: () => request('/complaints/bounces'),
    resolveBounce: (bounceId, note) =>
      request(`/complaints/bounces/${bounceId}/resolve`, { method: 'POST', body: JSON.stringify({ note }) }),
    // Search the mailboxes for every reference and account number on it.
    searchEmails: (id, all = false) =>
      request(`/complaints/${id}/search-emails`, { method: 'POST', body: JSON.stringify({ all }) }),
    undoEmail: (id, emailId) =>
      request(`/complaints/${id}/emails/${emailId}/undo`, { method: 'POST' }),
    refreshReview: (id) => request(`/complaints/${id}/review`, { method: 'POST' }),
    // The landlord's authority (server services/authority.js).
    authorityReply: (id) => request(`/complaints/${id}/authority/reply`, { method: 'POST' }),
    landlordDraft: (id, landlord_name) =>
      request(`/complaints/${id}/authority/landlord-draft`, { method: 'POST', body: JSON.stringify({ landlord_name }) }),
    sendToLandlord: (id, data) =>
      request(`/complaints/${id}/authority/landlord`, { method: 'POST', body: JSON.stringify(data) }),
    authorityDone: (id, note) =>
      request(`/complaints/${id}/authority/done`, { method: 'POST', body: JSON.stringify({ note }) }),
    // The documents a message relies on, chosen by the AI from their labels.
    chooseAttachments: (id, subject, body) =>
      request(`/complaints/${id}/choose-attachments`, { method: 'POST', body: JSON.stringify({ subject, body }) }),
    // The general inbox: emails the AI couldn't place with confidence.
    unfiledEmails: () => request('/complaints/emails/unfiled'),
    fileEmail: (emailId, complaintId) =>
      request(`/complaints/emails/${emailId}/file`, {
        method: 'POST',
        body: JSON.stringify({ complaint_id: complaintId }),
      }),
    dismissEmail: (emailId) => request(`/complaints/emails/${emailId}`, { method: 'DELETE' }),
    // Email automation: status, watched mailboxes, and finding past complaints.
    automation: () => request('/complaints/automation'),
    setWatched: (mailboxes) =>
      request('/complaints/automation', { method: 'PUT', body: JSON.stringify({ mailboxes }) }),
    startPastScan: (mailboxes, months) =>
      request('/complaints/past/scan', { method: 'POST', body: JSON.stringify({ mailboxes, months }) }),
    pastCandidates: () => request('/complaints/past/candidates'),
    importPast: (candId) => request(`/complaints/past/candidates/${candId}/import`, { method: 'POST' }),
    skipPast: (candId) => request(`/complaints/past/candidates/${candId}/skip`, { method: 'POST' }),
    tidy: () => request('/complaints/tidy'),
    mergeComplaints: (keepId, mergeId) =>
      request('/complaints/tidy/complaints', { method: 'POST', body: JSON.stringify({ keep_id: keepId, merge_id: mergeId }) }),
    mergeOrganisations: (keepId, mergeId) =>
      request('/complaints/tidy/organisations', { method: 'POST', body: JSON.stringify({ keep_id: keepId, merge_id: mergeId }) }),
    setAutoImport: (on) => request('/complaints/past/auto', { method: 'PUT', body: JSON.stringify({ on }) }),
    markChecked: (id) => request(`/complaints/${id}/checked`, { method: 'POST' }),
    // Answer the question a re-check raised: is_complaint | keep_date | use_date.
    answerDoubt: (id, answer) => request(`/complaints/${id}/doubt`, { method: 'POST', body: JSON.stringify({ answer }) }),
    linkPast: (candId, complaintId) =>
      request(`/complaints/past/candidates/${candId}/link`, {
        method: 'POST',
        body: JSON.stringify({ complaint_id: complaintId }),
      }),
    emailConfig: () => request('/complaints/email/config'),
    fetchEmails: () => request('/complaints/email/fetch', { method: 'POST' }),
    aiConfig: () => request('/complaints/ai/config'),
    assist: (id, data) =>
      request(`/complaints/${id}/assist`, { method: 'POST', body: JSON.stringify(data) }),
    // Queued and sent in the background (202): the complaint's `outbox` says
    // how it is going.
    resendDraft: (id, emailId) => request(`/complaints/${id}/emails/${emailId}/resend`, { method: 'POST' }),
    sendEmail: (id, data) =>
      request(`/complaints/${id}/send-email`, { method: 'POST', body: JSON.stringify(data) }),
    retryOutbox: (id, outboxId) => request(`/complaints/${id}/outbox/${outboxId}/retry`, { method: 'POST' }),
    // It went after all (the copy is in utilities@): recorded, not re-sent.
    outboxWent: (id, outboxId) => request(`/complaints/${id}/outbox/${outboxId}/went`, { method: 'POST' }),
    discardOutbox: (id, outboxId) => request(`/complaints/${id}/outbox/${outboxId}`, { method: 'DELETE' }),
    checkStatus: (id) => request(`/complaints/${id}/check-status`, { method: 'POST' }),
    referralPack: (id) => request(`/complaints/${id}/referral-pack`, { method: 'POST' }),
    // The referral as an email to the ombudsman (where it takes one), drafted
    // from the facts on file (and the pack's grounds when built); sent in the
    // background with the evidence attached, and the part moves to the
    // ombudsman once it has gone.
    referralDraft: (id, partyId, grounds) =>
      request(`/complaints/${id}/referral/draft`, { method: 'POST', body: JSON.stringify({ party_id: partyId || null, grounds: grounds || null }) }),
    sendReferral: (id, data) =>
      request(`/complaints/${id}/referral/send`, { method: 'POST', body: JSON.stringify(data) }),
    // Fill the log form from the complaint itself: pasted text, an uploaded
    // email/letter, or an email waiting to be filed. Saves nothing.
    parseImport: ({ text, file, emailId } = {}) => {
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        return request('/complaints/import/parse', { method: 'POST', body: fd });
      }
      return request('/complaints/import/parse', {
        method: 'POST',
        body: JSON.stringify({ text: text || null, email_id: emailId || null }),
      });
    },
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
  managing_agent: 'Managing agent / freeholder',
  debt_collector: 'Debt collector',
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

// The UK calendar day of a timestamp (an email's arrival). Slicing the ISO
// string gives the UTC day, which is a day early for anything 00:00–01:00 BST.
export function londonDay(ts) {
  if (!ts) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(ts));
}

// What a complaint is known by, for the "Account number" column and field:
// its account numbers, or — when it has none (not every complaint is about an
// account) — their reference(s) instead, marked as such. Display only: a
// reference is never stored as an account number, because the same account
// number means the same complaint even across organisations, and a reference
// is only one organisation's.
// Every organisation's reference on an email, labelled: "Your reference: …"
// for the one it goes to, "<organisation> reference: …" for each other one,
// added under the greeting when the email doesn't already quote it. The same
// rule as server/src/lib/references.js. `toKey`: 'main', a party id, or null.
const refKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function complaintTracks(c) {
  return [{ key: 'main', org_name: c?.org_name, reference: c?.reference },
    ...(c?.parties || []).map((p) => ({ key: p.id, org_name: p.org_name, reference: p.reference }))];
}
export function referenceLines(tracks, toKey = null) {
  const known = (tracks || []).filter((t) => t && String(t.reference || '').trim());
  return [
    ...known.filter((t) => toKey && t.key === toKey).map((t) => `Your reference: ${t.reference.trim()}`),
    ...known.filter((t) => !(toKey && t.key === toKey)).map((t) => `${t.org_name} reference: ${t.reference.trim()}`),
  ];
}
export function withReferences(body, lines) {
  const text = String(body || '');
  if (!text.trim() || !lines?.length) return text;
  const flat = refKey(text);
  const missing = lines.filter((l) => {
    const ref = refKey(l.slice(l.indexOf(':') + 1));
    return ref.length >= 3 && !flat.includes(ref);
  });
  if (!missing.length) return text;
  const block = missing.join('\n');
  const greet = text.match(/^\s*((?:dear|hello|hi|good (?:morning|afternoon|evening))\b[^\n]*)\n+/i);
  if (greet) return `${greet[1]}\n\n${block}\n\n${text.slice(greet[0].length)}`;
  return `${block}\n\n${text.replace(/^\s+/, '')}`;
}

export function accountOrReference(c) {
  const accounts = (c?.account_numbers || []).filter(Boolean);
  if (accounts.length) return { values: accounts, isReference: false };
  const refs = [...new Set([c?.reference, ...(c?.parties || []).map((p) => p.reference)].filter(Boolean))];
  return { values: refs, isReference: refs.length > 0 };
}

export function formatDate(d) {
  if (!d) return '—';
  const date = new Date(d + (d.length === 10 ? 'T00:00:00' : ''));
  // "Sep", as the server writes it (ukDate), not the browser's "Sept".
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).replace('Sept', 'Sep');
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

// A draft signed by the person sending it: "[Name]" / "[Your name]" becomes
// their name and "[Job title]" their title (dropped, with its line, when none
// is set). The same rule as server/src/lib/signature.js, which signs anything
// sent as a backstop, so what is shown and copied is what goes out.
const SIGN_NAME = /\[\s*(?:your\s+)?(?:full\s+)?name\s*\]/gi;
const SIGN_TITLE = /\[\s*(?:your\s+)?(?:job\s*title|position|role|title)\s*\]/gi;
export function signEmail(text, user) {
  let s = String(text ?? '');
  // No name set: their email address, never "[Name]". Functions, so a "$"
  // in either is kept as typed.
  const name = user?.name || user?.email;
  if (name) s = s.replace(SIGN_NAME, () => name);
  if (user?.job_title) s = s.replace(SIGN_TITLE, () => user.job_title);
  else s = s.replace(new RegExp(`^[ \\t]*${SIGN_TITLE.source}[ \\t]*\\n?`, 'gim'), '').replace(SIGN_TITLE, '');
  return s;
}

// A gap left to fill in ("[Paste our email here]", "[DATE]"), by the same
// rule as server/src/lib/signature.js#gapIn, which refuses the send: the
// window says so before Send is pressed.
const PLACEHOLDER = /\b(?:name|date|amount|address|insert|paste|add|enter|fill|details?|title|number|here|tbc|xx+|landlord|tenant|supplier|organi[sz]ation|company|reference|ref|postcode|mpan|mprn|e-?mail|phone|telephone|account|month|year|day|time|signature|figure|sum|total)\b/i;
// What a person is told to do, never part of a reference.
const INSTRUCTION = /\b(?:insert|paste|add|enter|fill|here|tbc|to\s+follow|complete|e\.?g|eg|example|or|check|which|confirm)\b/i;
// In a subject, only a blank to fill in: a reply's subject is "Re: <their
// subject>", and their tags name all sorts ("[External Email: Do not click
// links]", "[Account Query]").
const SUBJECT_PLACEHOLDER = /\b(?:name|date|amount|insert|paste|add|enter|fill|here|tbc|xx+|postcode)\b/i;
// What a mail system or a council puts in brackets ("[EXTERNAL]", "[EXTERNAL
// EMAIL]", "[OFFICIAL-SENSITIVE]"): the whole bracket, never the start of a
// sentence ("[External link]", "[Re-attach the bill]").
const TAG = /^\s*(?:external(?:\s+(?:e-?mail|sender|message|mail))?|ext|secure|spam|suspected\s+spam|encrypt(?:ed)?|fwd?|re|caution|warning|urgent|important|confidential|official(?:[-\s]sensitive)?|sensitive|not\s+protectively\s+marked)\s*$/i;
// A blank to type a figure into: zeros, X's, underscores ("[00/00/0000]",
// "[XX/XX/XXXX]", "[£___]", "[0.00]").
// "[DD/MM/YYYY]" too.
const BLANK = (c) => /^[\s0xXdDmMyY\/.\-_£,:]+$/.test(c) && /[0xX_]|[dD]{2}|[mM]{2}|[yY]{2}/.test(c);
// A reference with its label ("[Ticket #12345 - Your complaint]", "[Case Ref:
// CAS-12345-ABCD]", "[Your reference: 12345]", "[ref:_00D4J2Ez._5008d:ref]"):
// a label word, then something with a digit in it, and no instruction.
const LABELLED = /^\s*(?:ticket|ref(?:erence)?|our\s+ref(?:erence)?|your\s+ref(?:erence)?|their\s+ref(?:erence)?|case(?:\s+ref(?:erence)?)?|incident|job|account(?:\s+(?:no\.?|number))?|crm|claim|policy|invoice|order|customer\s+(?:no\.?|number))\b\.?\s*(?:no\.?|number)?\s*[:#_]?/i;
const notGap = (c) => {
  if (/^\s*sic\s*$/i.test(c) || /@|:\/\/|cid:|mailto:|^\s*image\s*:/i.test(c)) return true;
  if (/^\s*GC-(?:C|CI|COM)-[A-Z0-9]+\s*$/i.test(c)) return true;
  if (BLANK(c)) return false;
  if (TAG.test(c)) return true;
  // ...but not "[Account no: 00000000]" or "[Account number, e.g. 850123456]".
  if (LABELLED.test(c) && /\d/.test(c) && !INSTRUCTION.test(c) && !BLANK(c.replace(LABELLED, '').trim())) return true;
  // Text in capitals and figures ("[PDF]", "[CRM:0012345]", "[850123456]"),
  // unless it is a placeholder ("[NAME]", "[POSTCODE]", "[ACCOUNT NUMBER]").
  if (!/[a-z]/.test(c) && !PLACEHOLDER.test(c)) return true;
  // One or two small letters ("[ok]", "[a]") are not a blank to fill in.
  if (/^\s*[a-z]{1,2}\s*$/i.test(c) && !/x/i.test(c)) return true;
  return false;
};
const BRACKETS = /\[([^\]\n]{2,})\]/g;
export function gapIn(subject, body = '') {
  // On an "Attached:" line, the file names (a copy's name carries their own
  // subject's tags: "Email 16 Sep 2026 - [EXTERNAL EMAIL] RE ….pdf", no gap
  // anyone could fill); anything else on it is checked like the rest.
  const own = String(body ?? '').replace(/^([ \t]*Attached: )(.*)$/gm, (_, lead, list) =>
    lead + list.replace(/\.\s*$/, '').split(/;\s*/).filter((f) => !/\.[A-Za-z0-9]{2,5}$/.test(f.trim())).join('; '));
  for (const [text, isSubject] of [[subject, true], [own, false]]) {
    for (const m of String(text ?? '').matchAll(BRACKETS)) {
      if (notGap(m[1])) continue;
      if (isSubject && !SUBJECT_PLACEHOLDER.test(m[1]) && !BLANK(m[1])) continue;
      return m[0];
    }
  }
  return null;
}

// "1 invoice" / "3 invoices"; with two words, the one that agrees: "1 needs",
// "3 need".
export function plural(n, one, many) {
  if (many) return `${n} ${n === 1 ? one : many}`;
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}
