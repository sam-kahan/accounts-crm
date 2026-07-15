import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, formatDate, dueClass } from '../api';
import Modal from '../components/Modal.jsx';

const STATUS_BADGE = {
  active: 'ok',
  dormant: 'amber',
  dissolved: 'red',
  other: 'grey',
};

function AddCompanyModal({ onClose, onAdded }) {
  const [tab, setTab] = useState('lookup'); // lookup | manual
  const [chEnabled, setChEnabled] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  const [manual, setManual] = useState({ name: '', company_number: '', status: 'active' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.companies.chConfig().then((c) => {
      setChEnabled(c.enabled);
      if (!c.enabled) setTab('manual');
    });
  }, []);

  async function search(e) {
    e.preventDefault();
    if (!q.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setResults(await api.companies.chSearch(q.trim()));
    } catch (err) {
      setError(err.message);
    } finally {
      setSearching(false);
    }
  }

  async function importCompany(number) {
    setBusy(true);
    setError(null);
    try {
      const created = await api.companies.import(number);
      onAdded(created);
    } catch (err) {
      setError(
        err.status === 409
          ? 'That company is already in the CRM.'
          : err.message,
      );
    } finally {
      setBusy(false);
    }
  }

  async function addManual(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.companies.create(manual);
      onAdded(created);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add company" onClose={onClose}>
      <div className="btn-row" style={{ marginBottom: 18 }}>
        <button
          className={tab === 'lookup' ? 'btn-primary btn-sm' : 'btn-sm'}
          onClick={() => setTab('lookup')}
          disabled={!chEnabled}
        >
          Companies House lookup
        </button>
        <button
          className={tab === 'manual' ? 'btn-primary btn-sm' : 'btn-sm'}
          onClick={() => setTab('manual')}
        >
          Enter manually
        </button>
      </div>

      {!chEnabled && tab === 'manual' && (
        <div className="inline-note warn" style={{ marginBottom: 16 }}>
          Companies House lookup is off. Add <code>COMPANIES_HOUSE_API_KEY</code> to the
          server .env to auto-import statutory dates.
        </div>
      )}

      {error && <div className="inline-note warn" style={{ marginBottom: 16 }}>{error}</div>}

      {tab === 'lookup' ? (
        <>
          <form onSubmit={search} className="toolbar">
            <input
              type="search"
              placeholder="Company name or number…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
            />
            <button className="btn-navy" disabled={searching}>
              {searching ? 'Searching…' : 'Search'}
            </button>
          </form>
          <div className="search-results">
            {results.length === 0 ? (
              <div className="empty" style={{ padding: 24 }}>
                Search Companies House to import a company and its key dates.
              </div>
            ) : (
              results.map((r) => (
                <div
                  key={r.company_number}
                  className="row"
                  onClick={() => !busy && importCompany(r.company_number)}
                >
                  <div>
                    <strong>{r.name}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {r.company_number} · {r.address}
                    </div>
                  </div>
                  <span className={`badge ${STATUS_BADGE[r.status] || 'grey'}`}>
                    {r.status}
                  </span>
                </div>
              ))
            )}
          </div>
        </>
      ) : (
        <form onSubmit={addManual}>
          <label className="field">
            <span className="lbl">Company name *</span>
            <input
              required
              value={manual.name}
              onChange={(e) => setManual({ ...manual, name: e.target.value })}
              autoFocus
            />
          </label>
          <div className="form-grid">
            <label className="field">
              <span className="lbl">Company number</span>
              <input
                value={manual.company_number}
                onChange={(e) =>
                  setManual({ ...manual, company_number: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span className="lbl">Status</span>
              <select
                value={manual.status}
                onChange={(e) => setManual({ ...manual, status: e.target.value })}
              >
                <option value="active">Active</option>
                <option value="dormant">Dormant</option>
                <option value="dissolved">Dissolved</option>
                <option value="other">Other</option>
              </select>
            </label>
          </div>
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-primary" disabled={busy}>
              {busy ? 'Adding…' : 'Add company'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export default function Companies() {
  const [companies, setCompanies] = useState(null);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const navigate = useNavigate();

  const load = (s = '') => api.companies.list(s).then(setCompanies);
  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  return (
    <>
      <div className="toolbar flex-between">
        <input
          type="search"
          placeholder="Search companies…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn-primary" onClick={() => setShowAdd(true)}>
          + Add company
        </button>
      </div>

      <div className="card">
        {!companies ? (
          <div className="spinner">Loading…</div>
        ) : companies.length === 0 ? (
          <div className="empty">
            No companies yet. Click <strong>Add company</strong> to import one from
            Companies House.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Number</th>
                <th>Status</th>
                <th>Accounts due</th>
                <th>Conf. stmt due</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr
                  key={c.id}
                  className="clickable"
                  onClick={() => navigate(`/companies/${c.id}`)}
                >
                  <td><strong>{c.name}</strong></td>
                  <td className="muted">{c.company_number || '—'}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[c.status] || 'grey'}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className={`due ${dueClass(c.accounts_next_due)}`}>
                    {formatDate(c.accounts_next_due)}
                  </td>
                  <td className={`due ${dueClass(c.confirmation_statement_next_due)}`}>
                    {formatDate(c.confirmation_statement_next_due)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAdd && (
        <AddCompanyModal
          onClose={() => setShowAdd(false)}
          onAdded={(c) => {
            setShowAdd(false);
            navigate(`/companies/${c.id}`);
          }}
        />
      )}
    </>
  );
}
