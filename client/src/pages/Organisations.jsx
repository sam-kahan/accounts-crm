import { useEffect, useState } from 'react';
import { api, ORG_TYPE_LABEL } from '../api';
import Modal from '../components/Modal.jsx';

const EMPTY = {
  name: '', type: 'council', location: '', complaints_email: '', complaints_url: '',
  phone: '', ombudsman_name: '', ombudsman_url: '', ombudsman_referral_months: '',
  stage1_response_days: '', stage2_response_days: '', ack_days: '',
  procedure_summary: '', legal_basis: '', sources: [], research_status: 'none', notes: '',
};

function num(v) { return v === '' || v == null ? null : Number(v); }

function OrgModal({ initial, researchEnabled, onClose, onSaved }) {
  const [form, setForm] = useState(initial || EMPTY);
  const [busy, setBusy] = useState(false);
  const [researching, setResearching] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function research() {
    if (!form.name.trim()) { setError('Enter the organisation name first.'); return; }
    setResearching(true);
    setError(null);
    try {
      const p = await api.organisations.research({
        name: form.name, type: form.type, location: form.location,
      });
      setForm((f) => ({
        ...f,
        complaints_email: p.complaints_email || f.complaints_email,
        complaints_url: p.complaints_url || f.complaints_url,
        phone: p.phone || f.phone,
        ombudsman_name: p.ombudsman_name || f.ombudsman_name,
        ombudsman_url: p.ombudsman_url || f.ombudsman_url,
        ombudsman_referral_months: p.ombudsman_referral_months ?? f.ombudsman_referral_months,
        stage1_response_days: p.stage1_response_days ?? f.stage1_response_days,
        stage2_response_days: p.stage2_response_days ?? f.stage2_response_days,
        ack_days: p.ack_days ?? f.ack_days,
        procedure_summary: p.procedure_summary || f.procedure_summary,
        legal_basis: p.legal_basis || f.legal_basis,
        sources: p.sources || f.sources,
        research_status: 'researched',
      }));
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
    const payload = {
      ...form,
      ombudsman_referral_months: num(form.ombudsman_referral_months),
      stage1_response_days: num(form.stage1_response_days),
      stage2_response_days: num(form.stage2_response_days),
      ack_days: num(form.ack_days),
    };
    try {
      const saved = initial?.id
        ? await api.organisations.update(initial.id, payload)
        : await api.organisations.create(payload);
      onSaved(saved);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={initial?.id ? 'Edit organisation' : 'Add organisation'} onClose={onClose}>
      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}
      <form onSubmit={save}>
        <div className="form-grid">
          <label className="field">
            <span className="lbl">Name *</span>
            <input required value={form.name} onChange={(e) => set('name', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Type</span>
            <select value={form.type} onChange={(e) => set('type', e.target.value)}>
              {Object.entries(ORG_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="field full">
            <span className="lbl">Location / area</span>
            <input value={form.location || ''} onChange={(e) => set('location', e.target.value)} placeholder="e.g. Liverpool" />
          </label>
        </div>

        <div className="flex-between" style={{ margin: '6px 0 14px' }}>
          <div className="muted" style={{ fontSize: 13 }}>
            {form.research_status === 'researched' ? '✓ Procedure researched — review below' : 'Research this body’s complaints procedure & deadlines'}
          </div>
          <button
            type="button"
            className="btn-navy btn-sm"
            onClick={research}
            disabled={researching || !researchEnabled}
            title={researchEnabled ? '' : 'Set ANTHROPIC_API_KEY on the server to enable'}
          >
            {researching ? 'Researching…' : '🔎 Research procedure'}
          </button>
        </div>
        {!researchEnabled && (
          <div className="inline-note warn" style={{ marginBottom: 14 }}>
            AI research is off. Add <code>ANTHROPIC_API_KEY</code> to the server .env to enable it;
            you can still fill the procedure in manually.
          </div>
        )}

        <div className="form-grid">
          <label className="field"><span className="lbl">Complaints email</span>
            <input value={form.complaints_email || ''} onChange={(e) => set('complaints_email', e.target.value)} /></label>
          <label className="field"><span className="lbl">Complaints page URL</span>
            <input value={form.complaints_url || ''} onChange={(e) => set('complaints_url', e.target.value)} /></label>
          <label className="field"><span className="lbl">Ombudsman</span>
            <input value={form.ombudsman_name || ''} onChange={(e) => set('ombudsman_name', e.target.value)} /></label>
          <label className="field"><span className="lbl">Ombudsman URL</span>
            <input value={form.ombudsman_url || ''} onChange={(e) => set('ombudsman_url', e.target.value)} /></label>
          <label className="field"><span className="lbl">Acknowledge (working days)</span>
            <input type="number" value={form.ack_days ?? ''} onChange={(e) => set('ack_days', e.target.value)} /></label>
          <label className="field"><span className="lbl">Referral window (months)</span>
            <input type="number" value={form.ombudsman_referral_months ?? ''} onChange={(e) => set('ombudsman_referral_months', e.target.value)} /></label>
          <label className="field"><span className="lbl">Stage 1 response (working days)</span>
            <input type="number" value={form.stage1_response_days ?? ''} onChange={(e) => set('stage1_response_days', e.target.value)} /></label>
          <label className="field"><span className="lbl">Stage 2 response (working days)</span>
            <input type="number" value={form.stage2_response_days ?? ''} onChange={(e) => set('stage2_response_days', e.target.value)} /></label>
          <label className="field full"><span className="lbl">Procedure summary</span>
            <textarea value={form.procedure_summary || ''} onChange={(e) => set('procedure_summary', e.target.value)} /></label>
          <label className="field full"><span className="lbl">Legal basis</span>
            <textarea value={form.legal_basis || ''} onChange={(e) => set('legal_basis', e.target.value)} /></label>
        </div>

        {form.sources?.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div className="lbl">Sources</div>
            <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 13 }}>
              {form.sources.map((s, i) => (
                <li key={i}><a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--green-600)' }}>{s.title || s.url}</a></li>
              ))}
            </ul>
          </div>
        )}

        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Organisations() {
  const [orgs, setOrgs] = useState(null);
  const [editing, setEditing] = useState(null); // org object or 'new'
  const [researchEnabled, setResearchEnabled] = useState(false);
  const [err, setErr] = useState(null);

  const load = () => {
    setErr(null);
    return api.organisations
      .list()
      .then(setOrgs)
      .catch((e) => setErr(e.message));
  };
  useEffect(() => {
    load();
    api.organisations
      .researchConfig()
      .then((c) => setResearchEnabled(c.enabled))
      .catch(() => setResearchEnabled(false));
  }, []);

  async function remove(o) {
    if (!confirm(`Delete ${o.name}?`)) return;
    try {
      await api.organisations.remove(o.id);
      await load();
    } catch (e) {
      setErr(e.message);
    }
  }

  return (
    <>
      <div className="toolbar flex-between">
        <div className="muted">Bodies you complain to, with their researched procedures.</div>
        <button className="btn-primary" onClick={() => setEditing('new')}>+ Add organisation</button>
      </div>

      {err && (
        <div className="inline-note warn" style={{ marginBottom: 12 }}>
          {err} <button className="linkish" onClick={load}>Retry</button>
        </div>
      )}

      <div className="card">
        {!orgs ? (
          err ? (
            <div className="empty">Couldn’t load organisations.</div>
          ) : (
            <div className="spinner">Loading…</div>
          )
        ) : orgs.length === 0 ? (
          <div className="empty">No organisations yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Name</th><th>Type</th><th>Ombudsman</th><th>Procedure</th><th>Complaints</th><th></th></tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id}>
                  <td
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    aria-label={`Edit ${o.name}`}
                    onClick={() => setEditing(o)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setEditing(o);
                      }
                    }}
                  >
                    <strong>{o.name}</strong>
                    {o.location && <div className="muted" style={{ fontSize: 12 }}>{o.location}</div>}</td>
                  <td><span className="badge navy">{ORG_TYPE_LABEL[o.type] || o.type}</span></td>
                  <td className="muted">{o.ombudsman_name || '—'}</td>
                  <td>
                    <span className={`badge ${o.research_status === 'researched' ? 'green' : o.research_status === 'manual' ? 'ok' : 'grey'}`}>
                      {o.research_status === 'researched' ? 'Researched' : o.research_status === 'manual' ? 'Set' : 'Not set'}
                    </span>
                  </td>
                  <td className="muted">{o.complaint_count || 0}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn-ghost btn-sm" onClick={() => setEditing(o)}>Edit</button>
                    <button className="btn-danger btn-sm" onClick={() => remove(o)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <OrgModal
          initial={editing === 'new' ? null : editing}
          researchEnabled={researchEnabled}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </>
  );
}
