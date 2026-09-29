import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate, ORG_TYPE_LABEL } from '../api';
import { useAuth } from '../auth.jsx';
import Modal from '../components/Modal.jsx';

// ---------------------------------------------------------------------------
// The ombudsman register: each scheme's own rules for taking a case, how to
// raise one, and the source of every figure. Nothing counts (the system never
// says a complaint can go there) until a person has checked the record
// against the scheme's official website and ticked it.
// ---------------------------------------------------------------------------

const EVIDENCE_LABEL = {
  wait_weeks: 'When it can take a case', after_final_response: 'After the final response', time_limit: 'Time limit',
  who_can_complain: 'Who can complain', representative: 'Complaining for someone else', what_to_include: 'What to include',
  refer_url: 'How to refer', refer_email: 'Complaints by email', phone: 'Phone', email: 'Email', housing: 'Council as landlord', service_charges: 'Service charges',
  watrs: 'WATRS', adr_stopped: 'Adjudication stopped', charges: 'Charges for representatives',
};

// When it will take a case, in words.
export function whenItTakes(s) {
  const ways = [];
  if (s.wait_weeks) ways.push(`${s.wait_weeks} weeks after the complaint was made, with no final response`);
  if (s.after_final_response) ways.push('once their final response (deadlock letter) has come');
  if (s.after_missed_deadline) ways.push('once they have missed their last deadline');
  return ways.length ? ways.join('; or ') : 'Not known';
}
export function timeLimit(s) {
  if (!s.time_limit_months) return 'Not known';
  return `${s.time_limit_months} months from ${s.time_limit_from === 'final_response' ? 'their final response' : 'when the complaint was made'}`;
}

export default function Ombudsmen() {
  const { canEdit } = useAuth();
  const mayEdit = canEdit('complaints');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = () => {
    setErr(null);
    return api.ombudsmen.list().then(setRows).catch((e) => setErr(e.message));
  };
  useEffect(() => { load(); }, []);

  if (!rows) {
    return err ? (
      <div className="card">
        <div className="inline-note warn" style={{ marginBottom: 12 }}>Couldn’t load the ombudsmen: {err}</div>
        <button className="btn-primary btn-sm" onClick={load}>Retry</button>
      </div>
    ) : <div className="spinner">Loading…</div>;
  }
  const unchecked = rows.filter((s) => !s.verified_at);
  return (
    <>
      <div className="inline-note" style={{ marginBottom: 16 }}>
        Each ombudsman’s own rules: when it will take a case, the time limit, who can complain and how. Complaint
        deadlines and “can it go to the ombudsman” are worked out from these, and the system never says a complaint
        can go to a scheme until its record here has been <strong>checked against its official website</strong>.
      </div>
      {unchecked.length > 0 && (
        <div className="inline-note warn" style={{ marginBottom: 16 }} role="alert">
          <strong>⚠ {unchecked.length === 1 ? '1 record hasn’t' : `${unchecked.length} records haven’t`} been checked yet:</strong>{' '}
          {unchecked.map((s) => s.name).join(', ')}. Until one is, no complaint going to that scheme is shown as ready to refer.
          Open its sources, compare each figure with their website, correct anything that differs, and tick “checked”.
        </div>
      )}
      {msg && <div className="inline-note" style={{ marginBottom: 16 }}>{msg}</div>}
      {rows.map((s) => (
        <div className="card" key={s.id} style={{ marginBottom: 16 }}>
          <div className="card-head">
            <h2>{s.name}</h2>
            {s.verified_at
              ? <span className="badge ok">Checked by {s.verified_by || 'a colleague'} on {formatDate(String(s.verified_at).slice(0, 10))}</span>
              : <span className="badge amber">Not checked</span>}
          </div>
          <div className="card-body">
            <div className="form-grid">
              <div><div><strong>It will take a case</strong></div>{whenItTakes(s)}</div>
              <div><div><strong>Time limit</strong></div>{timeLimit(s)}</div>
              <div>
                <div><strong>How to refer</strong></div>
                {s.refer_email && (
                  <div><strong>By email:</strong> {s.refer_email} (the referral can be sent from the complaint)
                    {s.refer_email_note && <div className="muted" style={{ fontSize: 13 }}>{s.refer_email_note}</div>}
                  </div>
                )}
                {s.refer_url ? <div><a href={s.refer_url} target="_blank" rel="noreferrer">{s.refer_email ? 'Or on their website ↗' : 'Their complaint form ↗'}</a></div> : (!s.refer_email && 'Not known')}
                {s.phone && <div>Phone: {s.phone}</div>}
                {s.email && s.email !== s.refer_email && <div>Email: {s.email}</div>}
                {s.post && <div className="muted" style={{ fontSize: 13 }}>Post: {s.post}</div>}
              </div>
              <div>
                <div><strong>Used for</strong></div>
                {s.usual_for?.length > 0 && <div>Usual for: {s.usual_for.map((t) => ORG_TYPE_LABEL[t] || t).join(', ')}</div>}
                {s.organisations?.length
                  ? <div className="muted" style={{ fontSize: 13 }}>{s.organisations.map((o) => o.name).join(', ')}</div>
                  : <div className="muted" style={{ fontSize: 13 }}>No organisation yet (chosen on the Organisations page)</div>}
              </div>
            </div>
            {s.who_can_complain && <p><strong>Who can complain:</strong> {s.who_can_complain}</p>}
            {s.representative && <p><strong>Complaining for someone else (e.g. for a landlord):</strong> {s.representative}</p>}
            {s.what_to_include?.length > 0 && (
              <>
                <strong>What to include</strong>
                <ul style={{ marginTop: 4 }}>{s.what_to_include.map((x) => <li key={x}>{x}</li>)}</ul>
              </>
            )}
            {s.notes && <p style={{ whiteSpace: 'pre-wrap' }}><strong>Notes:</strong> {s.notes}</p>}
            {Object.keys(s.evidence || {}).length > 0 && (
              <details>
                <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Where each figure came from ({Object.keys(s.evidence).length})</summary>
                <ul style={{ fontSize: 13 }}>
                  {Object.entries(s.evidence).map(([k, e]) => (
                    <li key={k} style={{ marginBottom: 6 }}>
                      <strong>{EVIDENCE_LABEL[k] || k.replace(/_/g, ' ')}:</strong> “{e.text}”{' '}
                      <a href={e.url} target="_blank" rel="noreferrer">source ↗</a>
                    </li>
                  ))}
                </ul>
                <p className="muted" style={{ fontSize: 12 }}>
                  Found by searching their official website on 29 Sep 2026 (the pages couldn’t be opened directly, so the
                  wording is as the search gave it). Open each source to confirm it before ticking “checked”.
                </p>
              </details>
            )}
            {mayEdit && (
              <div className="btn-row" style={{ marginTop: 10 }}>
                <button className="btn-primary btn-sm" onClick={() => setEditing(s)}>
                  {s.verified_at ? 'Edit' : 'Check and edit'}
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
      <p className="muted" style={{ fontSize: 13 }}>
        Which scheme an organisation belongs to is set on the <Link to="/organisations">Organisations</Link> page
        (a managing agent belongs to The Property Ombudsman or the Property Redress Scheme: it has to be chosen).
      </p>
      {editing && (
        <EditScheme
          scheme={editing}
          onClose={() => setEditing(null)}
          onSaved={(r) => {
            setEditing(null);
            setMsg(`Saved ${r.name}.${r.recalculated ? ` ${r.recalculated === 1 ? '1 open complaint has' : `${r.recalculated} open complaints have`} new dates; each change is noted on its timeline.` : ''}`);
            load();
          }}
        />
      )}
    </>
  );
}

function EditScheme({ scheme, onClose, onSaved }) {
  const [f, setF] = useState({
    ...scheme,
    wait_weeks: scheme.wait_weeks ?? '',
    time_limit_months: scheme.time_limit_months ?? '',
    time_limit_from: scheme.time_limit_from || '',
    what_to_include: (scheme.what_to_include || []).join('\n'),
    verified: Boolean(scheme.verified_at),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // Changing anything un-ticks "checked": what was checked against their
  // website is no longer what will be saved, and an unchecked scheme never
  // opens a referral (a wrong wait typed in must not count as checked).
  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setF((cur) => ({ ...cur, [k]: v, ...(k !== 'verified' && String(cur[k] ?? '') !== String(v ?? '') ? { verified: false } : {}) }));
  };
  const num = (v) => (v === '' || v === null ? null : Number(v));
  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const r = await api.ombudsmen.update(scheme.id, {
        name: f.name, website: f.website || null, refer_url: f.refer_url || null, phone: f.phone || null,
        email: f.email || null, post: f.post || null,
        refer_email: f.refer_email || null, refer_email_note: f.refer_email_note || null,
        wait_weeks: num(f.wait_weeks), after_final_response: Boolean(f.after_final_response),
        after_missed_deadline: Boolean(f.after_missed_deadline),
        time_limit_months: num(f.time_limit_months), time_limit_from: f.time_limit_from || null,
        who_can_complain: f.who_can_complain || null, representative: f.representative || null,
        what_to_include: String(f.what_to_include || '').split('\n').map((x) => x.trim()).filter(Boolean),
        notes: f.notes || null, verified: Boolean(f.verified),
      });
      onSaved(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title={scheme.name} onClose={onClose} wide
      footer={
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="scheme-form" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      }>
      <form id="scheme-form" onSubmit={save}>
        {error && <div className="inline-note warn" style={{ marginBottom: 12 }}>{error}</div>}
        {/* What to check each figure against, beside the figures themselves. */}
        {Object.keys(scheme.evidence || {}).length > 0 && (
          <details open className="inline-note" style={{ marginBottom: 12 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Check against these sources</summary>
            <ul style={{ fontSize: 13, margin: '6px 0 0' }}>
              {Object.entries(scheme.evidence).map(([k, e]) => (
                <li key={k} style={{ marginBottom: 4 }}>
                  <strong>{EVIDENCE_LABEL[k] || k.replace(/_/g, ' ')}:</strong> “{e.text}”{' '}
                  <a href={e.url} target="_blank" rel="noreferrer">open the page ↗</a>
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="form-grid">
          <label>Name<input value={f.name || ''} onChange={set('name')} required /></label>
          <label>Website<input value={f.website || ''} onChange={set('website')} /></label>
          <label>Where a case is made (their form)<input value={f.refer_url || ''} onChange={set('refer_url')} /></label>
          <label>Phone<input value={f.phone || ''} onChange={set('phone')} /></label>
          <label>Email (general)<input value={f.email || ''} onChange={set('email')} /></label>
          <label>Email that takes a NEW complaint (blank: they don't take one by email)
            <input type="email" value={f.refer_email || ''} onChange={set('refer_email')} />
          </label>
          <label>What they say about complaining by email (their form to attach, size limits)
            <input value={f.refer_email_note || ''} onChange={set('refer_email_note')} />
          </label>
          <label>Post<input value={f.post || ''} onChange={set('post')} /></label>
        </div>
        <h3 style={{ marginTop: 16 }}>When it will take a case</h3>
        <div className="form-grid">
          <label>Weeks after the complaint was made (blank: no such rule)
            <input type="number" min="1" value={f.wait_weeks} onChange={set('wait_weeks')} />
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={Boolean(f.after_final_response)} onChange={set('after_final_response')} />
            Once their final response / deadlock letter has come
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={Boolean(f.after_missed_deadline)} onChange={set('after_missed_deadline')} />
            Once they have missed their last deadline
          </label>
        </div>
        <h3 style={{ marginTop: 16 }}>Time limit to take it there</h3>
        <div className="form-grid">
          <label>Months (blank: not known)<input type="number" min="1" value={f.time_limit_months} onChange={set('time_limit_months')} /></label>
          <label>Counted from
            <select value={f.time_limit_from} onChange={set('time_limit_from')}>
              <option value="">Not known</option>
              <option value="final_response">Their final response</option>
              <option value="raised">When the complaint was made</option>
            </select>
          </label>
        </div>
        <label style={{ marginTop: 12, display: 'block' }}>Who can complain<textarea rows={3} value={f.who_can_complain || ''} onChange={set('who_can_complain')} /></label>
        <label style={{ display: 'block' }}>Complaining for someone else (the authority needed)<textarea rows={3} value={f.representative || ''} onChange={set('representative')} /></label>
        <label style={{ display: 'block' }}>What to include (one per line)<textarea rows={5} value={f.what_to_include} onChange={set('what_to_include')} /></label>
        <label style={{ display: 'block' }}>Notes<textarea rows={5} value={f.notes || ''} onChange={set('notes')} /></label>
        <label className="inline-note" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12 }}>
          <input type="checkbox" checked={Boolean(f.verified)} onChange={set('verified')} style={{ marginTop: 3 }} />
          <span>
            <strong>I have checked every figure here against {scheme.name}’s official website.</strong> Saving without
            this tick clears it, and a change to any figure has to be checked again.
          </span>
        </label>
      </form>
    </Modal>
  );
}
