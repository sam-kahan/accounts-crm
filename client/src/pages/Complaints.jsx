import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, formatDate, todayISO, ORG_TYPE_LABEL } from '../api';
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

function NewComplaintModal({
  orgs: initialOrgs, researchEnabled, onClose, onCreated, initial, importMode, importNotes,
}) {
  const today = todayISO();
  const [orgs, setOrgs] = useState(initialOrgs);
  const [form, setForm] = useState({
    organisation_id: '',
    org_name: '',
    org_type: 'council',
    location: '',
    subject: '',
    property: '',
    category: '',
    channel: 'email',
    reference: '',
    our_reference: '',
    raised_on: today,
    description: '',
    stage: 'stage_1',
    acknowledged_on: '',
    responded_on: '',
    ...(initial || {}),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [researching, setResearching] = useState(false);
  const [note, setNote] = useState(null);

  function pickOrg(id) {
    const org = orgs.find((o) => o.id === id);
    setNote(null);
    setForm({
      ...form,
      organisation_id: id,
      org_name: org ? org.name : form.org_name,
      org_type: org ? org.type : form.org_type,
    });
  }

  // Research this provider, save it as an organisation, and link the complaint
  // to it so its tailored deadlines apply.
  async function researchOrg() {
    if (!form.org_name.trim()) { setError('Enter the organisation name first.'); return; }
    setResearching(true);
    setError(null);
    setNote(null);
    try {
      const org = await api.organisations.researchAndCreate({
        name: form.org_name, type: form.org_type, location: form.location,
      });
      setOrgs((prev) => (prev.some((o) => o.id === org.id) ? prev : [...prev, org]));
      setForm((f) => ({ ...f, organisation_id: org.id, org_name: org.name, org_type: org.type }));
      setNote(
        org.existed
          ? `Linked to existing organisation “${org.name}”.`
          : `Researched “${org.name}” — ${org.ombudsman_name || 'procedure'} and deadlines tailored.`,
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setResearching(false);
    }
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.complaints.create({
        ...form,
        organisation_id: form.organisation_id || null,
        acknowledged_on: form.acknowledged_on || null,
        responded_on: form.responded_on || null,
        imported: Boolean(importMode),
      });
      onCreated(created);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={importMode ? 'Review imported complaint' : 'Log a complaint'} onClose={onClose}>
      {importMode && (
        <div className="inline-note" style={{ marginBottom: 14 }}>
          The AI worked these out from what you pasted — <strong>check the date raised, stage and
          any response dates</strong> before saving. Deadlines are recalculated from them.
          {importNotes && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{importNotes}</div>}
        </div>
      )}
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
          {!form.organisation_id && (
            <div className="full flex-between" style={{ marginBottom: 12, gap: 12 }}>
              <input
                style={{ maxWidth: 220 }}
                placeholder="Location / area (helps research)"
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
              />
              <button
                type="button"
                className="btn-navy btn-sm"
                onClick={researchOrg}
                disabled={researching || !researchEnabled}
                title={researchEnabled ? '' : 'Set ANTHROPIC_API_KEY on the server to enable'}
              >
                {researching ? 'Researching…' : '🔎 Research & tailor this provider'}
              </button>
            </div>
          )}
          {note && <div className="inline-note full" style={{ marginBottom: 12 }}>{note}</div>}
          {form.organisation_id && (
            <div className="inline-note full" style={{ marginBottom: 12 }}>
              ✓ Linked to a saved organisation — its tailored deadlines will apply.
            </div>
          )}
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
          {importMode && (
            <>
              <label className="field">
                <span className="lbl">Current stage</span>
                <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>
                  <option value="stage_1">Stage 1</option>
                  <option value="stage_2">Stage 2</option>
                  <option value="ombudsman">Ombudsman</option>
                </select>
              </label>
              <label className="field">
                <span className="lbl">Acknowledged on</span>
                <input type="date" value={form.acknowledged_on || ''}
                  onChange={(e) => setForm({ ...form, acknowledged_on: e.target.value })} />
              </label>
              <label className="field">
                <span className="lbl">They responded on</span>
                <input type="date" value={form.responded_on || ''}
                  onChange={(e) => setForm({ ...form, responded_on: e.target.value })} />
              </label>
            </>
          )}
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

// Paste an existing complaint (email thread / notes); the AI extracts the
// fields and hands them to the review form.
function ImportModal({ onClose, onParsed }) {
  const [text, setText] = useState('');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function analyse() {
    setBusy(true);
    setError(null);
    try {
      const parsed = await api.complaints.parseImport(text, hint);
      onParsed(parsed);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Import an existing complaint"
      onClose={onClose}
      footer={
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={analyse} disabled={busy || text.trim().length < 20}>
            {busy ? 'Analysing…' : 'Analyse & pre-fill'}
          </button>
        </div>
      }
    >
      {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Paste the email thread, letters or notes for a complaint you started before using this
        system. The AI will work out the organisation, when it was raised, any references, and what
        stage you’re at — then show it for you to check before saving.
      </p>
      <label className="field">
        <span className="lbl">Anything to note? (optional)</span>
        <input value={hint} onChange={(e) => setHint(e.target.value)}
          placeholder="e.g. This is Salford Council, about a missed repair" />
      </label>
      <label className="field">
        <span className="lbl">Paste the complaint material *</span>
        <textarea rows={12} value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Paste emails / letters / notes here…" />
        {text.trim().length < 20 && (
          <span className="muted" style={{ fontSize: 12 }}>
            Paste at least 20 characters to analyse.
          </span>
        )}
      </label>
    </Modal>
  );
}

function OverdueDraftsModal({ onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.complaints.overdueDrafts().then(setData).catch((e) => setError(e.message));
  }, []);

  return (
    <Modal title="Chasers for overdue complaints" onClose={onClose}>
      {error && <div className="login-error">{error}</div>}
      {!data && !error && <div className="spinner">Drafting chasers…</div>}
      {data && data.count === 0 && <div className="empty">No overdue complaints — nothing to chase. 🎉</div>}
      {data?.drafts?.map((d) => (
        <div className="card" key={d.id} style={{ marginBottom: 12 }}>
          <div className="card-head">
            <div>
              <strong>{d.subject}</strong>
              <div className="muted" style={{ fontSize: 12 }}>{d.org_name} · {d.ref_code}</div>
            </div>
            <button className="btn btn-sm" onClick={() => navigate(`/complaints/${d.id}`)}>Open</button>
          </div>
          <div className="card-body">
            {d.error ? (
              <div className="inline-note warn">Couldn’t draft: {d.error}</div>
            ) : (
              <>
                <div className="muted" style={{ fontSize: 12, fontWeight: 600 }}>{d.draft.email?.subject}</div>
                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, margin: '6px 0 0' }}>
                  {d.draft.email?.body}
                </pre>
                <div style={{ marginTop: 8 }}>
                  <button
                    className="btn btn-sm"
                    onClick={async () => {
                      try {
                        await navigator.clipboard?.writeText(
                          `Subject: ${d.draft.email?.subject}\n\n${d.draft.email?.body}`,
                        );
                        setCopiedId(d.id);
                        setTimeout(() => setCopiedId((c) => (c === d.id ? null : c)), 1500);
                      } catch {
                        /* clipboard unavailable */
                      }
                    }}
                  >
                    {copiedId === d.id ? 'Copied ✓' : 'Copy'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ))}
    </Modal>
  );
}

export default function Complaints() {
  const [items, setItems] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [researchEnabled, setResearchEnabled] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [filter, setFilter] = useState('open');
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importInitial, setImportInitial] = useState(null);
  const [showOverdue, setShowOverdue] = useState(false);
  const [err, setErr] = useState(null);
  const navigate = useNavigate();

  const load = () => {
    setErr(null);
    return api.complaints
      .list()
      .then(setItems)
      .catch((e) => setErr(e.message));
  };
  useEffect(() => {
    load();
    api.organisations.list().then(setOrgs).catch(() => setOrgs([]));
    api.organisations.researchConfig().then((c) => setResearchEnabled(c.enabled)).catch(() => {});
    api.complaints.aiConfig().then((c) => setAiEnabled(c.enabled)).catch(() => {});
  }, []);

  // Map the AI's parsed import into the review form's initial values.
  function toInitial(p) {
    const clean = (v) => v || '';
    return {
      org_name: clean(p.org_name),
      org_type: p.org_type || 'council',
      subject: clean(p.subject),
      category: clean(p.category),
      property: clean(p.property),
      reference: clean(p.reference),
      our_reference: clean(p.our_reference),
      channel: p.channel || 'email',
      raised_on: p.raised_on || todayISO(),
      acknowledged_on: clean(p.acknowledged_on),
      responded_on: clean(p.responded_on),
      stage: p.stage || 'stage_1',
      description: clean(p.description),
      _notes: [p.confidence ? `Confidence: ${p.confidence}.` : '', p.notes || ''].filter(Boolean).join(' '),
    };
  }

  if (!items) {
    if (err) {
      return (
        <div className="card">
          <div className="inline-note warn" style={{ marginBottom: 12 }}>
            Couldn’t load complaints: {err}
          </div>
          <button className="btn-primary btn-sm" onClick={load}>Retry</button>
        </div>
      );
    }
    return <div className="spinner">Loading complaints…</div>;
  }

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
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div className="btn-row">
          {aiEnabled && overdue.length > 0 && (
            <button className="btn-navy btn-sm" onClick={() => setShowOverdue(true)}>
              ✨ Draft overdue chasers
            </button>
          )}
          {aiEnabled && (
            <button className="btn btn-sm" onClick={() => setShowImport(true)}>Import existing</button>
          )}
          <button className="btn-primary" onClick={() => setShowNew(true)}>+ Log complaint</button>
        </div>
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
                <tr
                  key={c.id}
                  className="clickable"
                  role="button"
                  tabIndex={0}
                  aria-label={`Open complaint: ${c.subject}`}
                  onClick={() => navigate(`/complaints/${c.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/complaints/${c.id}`);
                    }
                  }}
                >
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
          researchEnabled={researchEnabled}
          onClose={() => setShowNew(false)}
          onCreated={(c) => {
            setShowNew(false);
            navigate(`/complaints/${c.id}`);
          }}
        />
      )}

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onParsed={(p) => {
            setShowImport(false);
            setImportInitial(toInitial(p));
          }}
        />
      )}

      {importInitial && (
        <NewComplaintModal
          orgs={orgs}
          researchEnabled={researchEnabled}
          importMode
          importNotes={importInitial._notes}
          initial={importInitial}
          onClose={() => setImportInitial(null)}
          onCreated={(c) => {
            setImportInitial(null);
            navigate(`/complaints/${c.id}`);
          }}
        />
      )}

      {showOverdue && <OverdueDraftsModal onClose={() => setShowOverdue(false)} />}
    </>
  );
}
