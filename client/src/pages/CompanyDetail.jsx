import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, formatDate, dueClass, daysUntil } from '../api';
import Modal from '../components/Modal.jsx';
import { useAuth } from '../auth.jsx';

const CATEGORY_LABEL = {
  year_end: 'Year end',
  accounts: 'Accounts',
  confirmation_statement: 'Confirmation statement',
  corporation_tax: 'Corporation tax',
  vat: 'VAT',
  paye: 'PAYE',
  custom: 'Other',
};

function AddKeyDateModal({ companyId, onClose, onSaved }) {
  const [form, setForm] = useState({
    company_id: companyId,
    category: 'custom',
    title: '',
    due_date: '',
    recurrence: 'none',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.keyDates.create(form);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add key date" onClose={onClose}>
      {error && <div className="inline-note warn" style={{ marginBottom: 14 }}>{error}</div>}
      <form onSubmit={save}>
        <label className="field">
          <span className="lbl">Title *</span>
          <input
            required
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="e.g. Q2 VAT return"
            autoFocus
          />
        </label>
        <div className="form-grid">
          <label className="field">
            <span className="lbl">Category</span>
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            >
              {Object.entries(CATEGORY_LABEL).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lbl">Due date *</span>
            <input
              required
              type="date"
              value={form.due_date}
              onChange={(e) => setForm({ ...form, due_date: e.target.value })}
            />
          </label>
          <label className="field full">
            <span className="lbl">Recurrence</span>
            <select
              value={form.recurrence}
              onChange={(e) => setForm({ ...form, recurrence: e.target.value })}
            >
              <option value="none">One-off</option>
              <option value="annual">Annual</option>
              <option value="quarterly">Quarterly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
        </div>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// The UK day of a timestamp (a sync at 00:30 BST is that day, not the UTC day before).
const ukDay = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });

export default function CompanyDetail() {
  // A confirmation statement can be filed from its date; it is late only
  // after its deadline (14 days on), which Companies House gives separately.
  const deadlineOf = (k) => (k.category === 'confirmation_statement' && k.source === 'companies_house'
    && company?.confirmation_statement_next_due && company.confirmation_statement_next_due >= k.due_date
    ? company.confirmation_statement_next_due : k.due_date);
  const { id } = useParams();
  const navigate = useNavigate();
  // The buttons that change anything only for someone who may (the server
  // refuses them to a view-only person).
  const mayEdit = useAuth().canEdit('companies');
  const [company, setCompany] = useState(null);
  const [showAddDate, setShowAddDate] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState(null);
  // The key date being marked done: its button waits, so a double-click can't
  // roll a recurring date on twice.
  const [completing, setCompleting] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const load = () => {
    setLoadError(null);
    return api.companies
      .get(id)
      .then(setCompany)
      .catch((e) => setLoadError(e.message));
  };
  useEffect(() => {
    load();
  }, [id]);

  async function sync() {
    setSyncing(true);
    setMsg(null);
    try {
      await api.companies.sync(id);
      await load();
      setMsg('Synced from Companies House.');
    } catch (e) {
      setMsg(e.message);
    } finally {
      setSyncing(false);
    }
  }

  async function completeDate(k) {
    if (completing) return;
    setMsg(null);
    setCompleting(k.id);
    try {
      await api.keyDates.complete(k.id, k.due_date);
      await load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setCompleting(null);
    }
  }
  async function removeDate(kdId) {
    if (!confirm('Delete this key date?')) return;
    setMsg(null);
    try {
      await api.keyDates.remove(kdId);
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  }
  async function removeCompany() {
    if (!confirm(`Delete ${company.name}? This removes its key dates and unlinks tasks.`)) return;
    try {
      await api.companies.remove(id);
      navigate('/companies');
    } catch (e) {
      setMsg(e.message);
    }
  }

  if (!company) {
    if (loadError) {
      return (
        <div className="card">
          <div className="inline-note warn" style={{ marginBottom: 12 }}>
            Couldn’t load this company: {loadError}
          </div>
          <div className="btn-row">
            <button className="btn-primary btn-sm" onClick={load}>Retry</button>
            <Link to="/companies" className="btn btn-sm">← Companies</Link>
          </div>
        </div>
      );
    }
    return <div className="spinner">Loading…</div>;
  }

  const pendingDates = company.key_dates.filter((k) => k.status === 'pending');
  const openTasks = company.tasks.filter((t) => t.status !== 'done');

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <Link to="/companies" className="btn-ghost btn-sm">← Companies</Link>
      </div>

      {msg && <div className="inline-note" style={{ marginBottom: 16 }}>{msg}</div>}

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-head">
          <div>
            <h2 style={{ fontSize: 20 }}>{company.name}</h2>
            <div className="muted" style={{ marginTop: 4 }}>
              {company.company_number ? `Company no. ${company.company_number}` : 'No company number'}
              {company.ch_last_synced_at &&
                ` · synced ${formatDate(ukDay(company.ch_last_synced_at))}`}
            </div>
          </div>
          <div className="btn-row">
            {mayEdit && company.company_number && (
              <button className="btn-navy btn-sm" onClick={sync} disabled={syncing}>
                {syncing ? 'Syncing…' : '⟳ Sync Companies House'}
              </button>
            )}
            {mayEdit && <button className="btn-danger btn-sm" onClick={removeCompany}>Delete</button>}
          </div>
        </div>
        <div className="card-body">
          <div className="form-grid">
            <Info label="Status" value={<span className="badge navy">{company.status}</span>} />
            <Info label="Incorporated" value={formatDate(company.incorporation_date)} />
            <Info label="Financial year end" value={
              <span className="due">
                {formatDate(company.accounts_next_made_up_to)}
              </span>
            } />
            <Info label="Accounts next due" value={
              <span className={`due ${dueClass(company.accounts_next_due)}`}>
                {formatDate(company.accounts_next_due)}
              </span>
            } />
            <Info label="Confirmation statement date" value={
              <span className="due">
                {formatDate(company.confirmation_statement_next_made_up_to)}
              </span>
            } />
            <Info label="Confirmation statement deadline" value={
              <span className={`due ${dueClass(company.confirmation_statement_next_due)}`}>
                {formatDate(company.confirmation_statement_next_due)}
              </span>
            } />
            {company.registered_office && (
              <Info label="Registered office" value={company.registered_office} full />
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-head">
          <h2>Key dates {pendingDates.length > 0 && <span className="badge navy">{pendingDates.length}</span>}</h2>
          {mayEdit && <button className="btn-primary btn-sm" onClick={() => setShowAddDate(true)}>+ Add key date</button>}
        </div>
        {pendingDates.length === 0 ? (
          <div className="empty">No pending key dates.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Due</th><th>Title</th><th>Category</th><th>Recurs</th><th>Source</th><th></th>
              </tr>
            </thead>
            <tbody>
              {pendingDates.map((k) => (
                <tr key={k.id}>
                  <td className={`due ${dueClass(deadlineOf(k))}`}>
                    {formatDate(k.due_date)}
                    {daysUntil(deadlineOf(k)) < 0 && <span className="badge red" style={{ marginLeft: 8 }}>overdue</span>}
                    {deadlineOf(k) !== k.due_date && daysUntil(k.due_date) <= 0 && daysUntil(deadlineOf(k)) >= 0 && (
                      <span className="badge amber" style={{ marginLeft: 8 }}>ready to file, deadline {formatDate(deadlineOf(k))}</span>
                    )}
                  </td>
                  <td>{k.title}</td>
                  <td><span className="badge grey">{CATEGORY_LABEL[k.category] || k.category}</span></td>
                  <td className="muted">{k.recurrence === 'none' ? '—' : k.recurrence}</td>
                  <td>
                    <span className={`badge ${k.source === 'companies_house' ? 'green' : 'grey'}`}>
                      {k.source === 'companies_house' ? 'Companies House' : 'manual'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {mayEdit && (<>
                      <button className="btn-ghost btn-sm" disabled={Boolean(completing)} onClick={() => completeDate(k)}>
                        {completing === k.id ? '…' : k.recurrence === 'none' || k.source === 'companies_house' ? 'Done' : 'Done ↻'}
                      </button>
                      <button className="btn-danger btn-sm" onClick={() => removeDate(k.id)}>Delete</button>
                    </>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!company.tasks_hidden && (
      <div className="card">
        <div className="card-head">
          <h2>Tasks {openTasks.length > 0 && <span className="badge navy">{openTasks.length}</span>}</h2>
          <Link to="/tasks" className="btn btn-sm">Manage tasks</Link>
        </div>
        {openTasks.length === 0 ? (
          <div className="empty">No open tasks for this company.</div>
        ) : (
          <table>
            <tbody>
              {openTasks.map((t) => (
                <tr key={t.id}>
                  <td className={`due ${dueClass(t.due_date)}`} style={{ width: 130 }}>
                    {formatDate(t.due_date)}
                  </td>
                  <td>{t.title}</td>
                  <td style={{ textAlign: 'right' }}>
                    <span className={`badge ${t.priority}`}>{t.priority}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      )}

      {showAddDate && (
        <AddKeyDateModal
          companyId={id}
          onClose={() => setShowAddDate(false)}
          onSaved={() => {
            setShowAddDate(false);
            load();
          }}
        />
      )}
    </>
  );
}

function Info({ label, value, full }) {
  return (
    <div className={full ? 'full' : ''} style={{ marginBottom: 14 }}>
      <div className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
        {label}
      </div>
      <div style={{ marginTop: 4, fontSize: 15 }}>{value}</div>
    </div>
  );
}
