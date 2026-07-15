import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, formatDate, ORG_TYPE_LABEL } from '../api';

const STAGE_LABEL = {
  stage_1: 'Stage 1', stage_2: 'Stage 2', ombudsman: 'Ombudsman',
  resolved: 'Resolved', closed: 'Closed',
};
const EVENT_LABEL = {
  raised: 'Raised', acknowledged: 'Acknowledged', chased: 'Chased',
  response_received: 'Response received', escalated: 'Escalated',
  resolved: 'Resolved', deadline_missed: 'Deadline missed', note: 'Note',
};

export default function ComplaintDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [c, setC] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const [ev, setEv] = useState({ event_date: today, type: 'chased', note: '' });

  const load = () => api.complaints.get(id).then(setC).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, [id]);

  async function addEvent(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.complaints.addEvent(id, ev);
      setEv({ event_date: today, type: 'chased', note: '' });
      await load();
    } finally {
      setBusy(false);
    }
  }
  async function escalate() {
    const label = c.stage === 'stage_1' ? 'Stage 2' : `the ${c.rule.ombudsman}`;
    if (!confirm(`Escalate this complaint to ${label}?`)) return;
    await api.complaints.escalate(id, today);
    load();
  }
  async function quick(type, note) {
    await api.complaints.addEvent(id, { event_date: today, type, note });
    load();
  }
  async function remove() {
    if (confirm('Delete this complaint and its timeline?')) {
      await api.complaints.remove(id);
      navigate('/complaints');
    }
  }

  if (!c) return <div className="spinner">Loading…</div>;

  const canEscalate = c.stage === 'stage_1' || c.stage === 'stage_2';

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <Link to="/complaints" className="btn-ghost btn-sm">← Complaints</Link>
      </div>
      {msg && <div className="inline-note warn" style={{ marginBottom: 16 }}>{msg}</div>}

      {/* Header + status */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <div>
            <h2 style={{ fontSize: 19 }}>{c.subject}</h2>
            <div className="muted" style={{ marginTop: 4 }}>
              {c.org_name} · {ORG_TYPE_LABEL[c.org_type] || c.org_type}
              {c.property && ` · ${c.property}`}
            </div>
          </div>
          <button className="btn-danger btn-sm" onClick={remove}>Delete</button>
        </div>
        <div className="card-body">
          <div className="form-grid">
            <Info label="Stage" value={<span className="badge navy">{STAGE_LABEL[c.stage]}</span>} />
            <Info label="Status" value={
              c.status === 'response_overdue'
                ? <span className="badge red">{c.label}</span>
                : c.status === 'responded' || c.status === 'resolved'
                ? <span className="badge ok">{c.label}</span>
                : <span className="badge amber">{c.label}</span>
            } />
            <Info label="Raised" value={formatDate(c.raised_on)} />
            <Info label="Response due" value={
              <span className={`due ${c.overdue ? 'overdue' : ''}`}>{formatDate(c.response_due)}</span>
            } />
            <Info label="Acknowledged" value={formatDate(c.acknowledged_on)} />
            <Info label="Ombudsman referral by" value={formatDate(c.ombudsman_deadline)} />
            {c.reference && <Info label="Their reference" value={c.reference} />}
            {c.channel && <Info label="Channel" value={c.channel} />}
          </div>

          {c.nextAction && (
            <div className="inline-note warn" style={{ marginTop: 8 }}>
              <strong>Next step:</strong> {c.nextAction}
            </div>
          )}

          <div className="btn-row" style={{ marginTop: 16 }}>
            {!c.acknowledged_on && c.state === 'open' && (
              <button className="btn btn-sm" onClick={() => quick('acknowledged', 'Acknowledged by organisation')}>
                Mark acknowledged
              </button>
            )}
            {c.state === 'open' && !c.responded_on && (
              <button className="btn btn-sm" onClick={() => quick('response_received', 'Response received')}>
                Mark response received
              </button>
            )}
            {canEscalate && c.state === 'open' && (
              <button className="btn-navy btn-sm" onClick={escalate}>
                Escalate to {c.stage === 'stage_1' ? 'Stage 2' : 'Ombudsman'}
              </button>
            )}
            {c.state === 'open' && (
              <button className="btn-primary btn-sm" onClick={() => quick('resolved', 'Complaint resolved')}>
                Mark resolved
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Legal basis */}
      {c.rule?.legalBasis && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-head"><h2>Complaints procedure &amp; the law</h2></div>
          <div className="card-body">
            <p style={{ marginTop: 0 }}>{c.rule.legalBasis}</p>
            <div className="muted" style={{ fontSize: 13 }}>
              Expected: acknowledge ~{c.rule.ackDays} working days · Stage 1 ~{c.rule.stage1Days} ·
              Stage 2 ~{c.rule.stage2Days} working days · refer to{' '}
              {c.rule.ombudsmanUrl
                ? <a href={c.rule.ombudsmanUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--green-600)' }}>{c.rule.ombudsman}</a>
                : c.rule.ombudsman}{' '}
              within {c.rule.referralMonths} months.
            </div>
          </div>
        </div>
      )}

      {/* Timeline */}
      <div className="card">
        <div className="card-head"><h2>Timeline &amp; evidence</h2></div>
        <div className="card-body">
          <form onSubmit={addEvent} className="form-grid" style={{ alignItems: 'end' }}>
            <label className="field">
              <span className="lbl">Date</span>
              <input type="date" value={ev.event_date} onChange={(e) => setEv({ ...ev, event_date: e.target.value })} required />
            </label>
            <label className="field">
              <span className="lbl">Event</span>
              <select value={ev.type} onChange={(e) => setEv({ ...ev, type: e.target.value })}>
                {Object.entries(EVENT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="field full">
              <span className="lbl">Note</span>
              <input value={ev.note} onChange={(e) => setEv({ ...ev, note: e.target.value })} placeholder="What happened" />
            </label>
            <div className="full" style={{ textAlign: 'right' }}>
              <button className="btn-primary btn-sm" disabled={busy}>{busy ? 'Adding…' : 'Add to timeline'}</button>
            </div>
          </form>

          {c.events?.length ? (
            <table style={{ marginTop: 8 }}>
              <tbody>
                {c.events.map((e) => (
                  <tr key={e.id}>
                    <td className="due" style={{ width: 130 }}>{formatDate(e.event_date)}</td>
                    <td style={{ width: 160 }}><span className="badge grey">{EVENT_LABEL[e.type] || e.type}</span></td>
                    <td>{e.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">No events yet.</div>
          )}
        </div>
      </div>
    </>
  );
}

function Info({ label, value }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 15 }}>{value}</div>
    </div>
  );
}
