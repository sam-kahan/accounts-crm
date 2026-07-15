import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, formatDate, ORG_TYPE_LABEL } from '../api';
import Modal from '../components/Modal.jsx';

const STAGE_LABEL = {
  stage_1: 'Stage 1',
  stage_2: 'Stage 2',
  ombudsman: 'Ombudsman',
  resolved: 'Resolved',
  closed: 'Closed',
};

function StatusBadge({ c }) {
  if (c.status === 'response_overdue') return <span className="badge red">{c.label}</span>;
  if (c.status === 'responded') return <span className="badge ok">Response received</span>;
  if (c.status === 'resolved') return <span className="badge ok">Resolved</span>;
  if (c.status === 'closed') return <span className="badge grey">Closed</span>;
  return <span className="badge amber">{c.label}</span>;
}

function NewComplaintModal({ orgs, onClose, onCreated }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    organisation_id: '',
    org_name: '',
    org_type: 'council',
    subject: '',
    property: '',
    category: '',
    channel: 'email',
    reference: '',
    raised_on: today,
    description: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function pickOrg(id) {
    const org = orgs.find((o) => o.id === id);
    setForm({
      ...form,
      organisation_id: id,
      org_name: org ? org.name : form.org_name,
      org_type: org ? org.type : form.org_type,
    });
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.complaints.create({
        ...form,
        organisation_id: form.organisation_id || null,
      });
      onCreated(created);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Log a complaint" onClose={onClose}>
      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}
      <form onSubmit={save}>
        <label className="field">
          <span className="lbl">Organisation</span>
          <select value={form.organisation_id} onChange={(e) => pickOrg(e.target.value)}>
            <option value="">— Type manually below —</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </label>
        <div className="form-grid">
          <label className="field">
            <span className="lbl">Organisation name *</span>
            <input
              required
              value={form.org_name}
              onChange={(e) => setForm({ ...form, org_name: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="lbl">Type</span>
            <select
              value={form.org_type}
              onChange={(e) => setForm({ ...form, org_type: e.target.value })}
              disabled={Boolean(form.organisation_id)}
            >
              {Object.entries(ORG_TYPE_LABEL).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
          <label className="field full">
            <span className="lbl">Subject *</span>
            <input
              required
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              placeholder="e.g. No response to repair request at 12 Foo St"
            />
          </label>
          <label className="field">
            <span className="lbl">Property / address</span>
            <input
              value={form.property}
              onChange={(e) => setForm({ ...form, property: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="lbl">Category</span>
            <input
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              placeholder="repairs, council tax, billing…"
            />
          </label>
          <label className="field">
            <span className="lbl">Date raised *</span>
            <input
              required
              type="date"
              value={form.raised_on}
              onChange={(e) => setForm({ ...form, raised_on: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="lbl">Channel</span>
            <select
              value={form.channel}
              onChange={(e) => setForm({ ...form, channel: e.target.value })}
            >
              <option value="email">Email</option>
              <option value="portal">Online portal</option>
              <option value="phone">Phone</option>
              <option value="letter">Letter</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="field">
            <span className="lbl">Their reference</span>
            <input
              value={form.reference}
              onChange={(e) => setForm({ ...form, reference: e.target.value })}
            />
          </label>
          <label className="field full">
            <span className="lbl">Details</span>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>
        </div>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Log complaint'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function Complaints() {
  const [items, setItems] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [filter, setFilter] = useState('open');
  const [showNew, setShowNew] = useState(false);
  const navigate = useNavigate();

  const load = () => api.complaints.list().then(setItems);
  useEffect(() => {
    load();
    api.organisations.list().then(setOrgs);
  }, []);

  if (!items) return <div className="spinner">Loading complaints…</div>;

  const overdue = items.filter((c) => c.status === 'response_overdue');
  const open = items.filter((c) => c.state === 'open');
  const shown =
    filter === 'overdue' ? overdue :
    filter === 'open' ? open :
    filter === 'resolved' ? items.filter((c) => c.state === 'resolved') :
    items;

  return (
    <>
      <div className="stat-row">
        <div className="stat accent">
          <div className="label">Open complaints</div>
          <div className="value">{open.length}</div>
        </div>
        <div className={`stat ${overdue.length ? 'alert' : ''}`}>
          <div className="label">Ignored / overdue</div>
          <div className="value">{overdue.length}</div>
        </div>
        <div className="stat">
          <div className="label">Total logged</div>
          <div className="value">{items.length}</div>
        </div>
      </div>

      <div className="toolbar flex-between">
        <div className="btn-row">
          {['open', 'overdue', 'resolved', 'all'].map((f) => (
            <button
              key={f}
              className={filter === f ? 'btn-primary btn-sm' : 'btn-sm'}
              onClick={() => setFilter(f)}
            >
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <button className="btn-primary" onClick={() => setShowNew(true)}>+ Log complaint</button>
      </div>

      <div className="card">
        {shown.length === 0 ? (
          <div className="empty">No complaints here.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Subject</th>
                <th>Organisation</th>
                <th>Stage</th>
                <th>Response due</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/complaints/${c.id}`)}>
                  <td>
                    <strong>{c.subject}</strong>
                    {c.property && <div className="muted" style={{ fontSize: 12 }}>{c.property}</div>}
                  </td>
                  <td className="muted">{c.org_name}</td>
                  <td><span className="badge navy">{STAGE_LABEL[c.stage] || c.stage}</span></td>
                  <td className={`due ${c.overdue ? 'overdue' : ''}`}>{formatDate(c.response_due)}</td>
                  <td><StatusBadge c={c} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showNew && (
        <NewComplaintModal
          orgs={orgs}
          onClose={() => setShowNew(false)}
          onCreated={(c) => {
            setShowNew(false);
            navigate(`/complaints/${c.id}`);
          }}
        />
      )}
    </>
  );
}
