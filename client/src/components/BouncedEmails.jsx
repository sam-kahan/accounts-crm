import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate, londonDay } from '../api';

// Emails that bounced and haven't been looked into (migration 030). An email
// that never arrived means a chaser nobody read, or a deadline counted from a
// complaint they never got, so each stays here until someone says what they
// found. Shown on the Complaints page; a complaint's own bounces also show on
// its page (BounceWarning).
export default function BouncedEmails({ refreshKey }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => {
    setErr(null);
    return api.complaints.bounces().then(setList).catch((e) => setErr(e.message));
  };
  useEffect(() => { load(); }, [refreshKey]);
  if (err) {
    return (
      <div className="inline-note warn" style={{ marginBottom: 20 }}>
        Couldn’t load bounced emails: {err}{' '}
        <button type="button" className="btn btn-sm" onClick={load}>Retry</button>
      </div>
    );
  }
  if (!list?.length) return null;
  return (
    <div className="card" style={{ marginBottom: 20, borderTop: '3px solid var(--red, #c0392b)' }}>
      <div className="card-head">
        <h2>Bounced emails to look into <span className="badge red">{list.length}</span></h2>
      </div>
      <div className="card-body">
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          These emails never arrived. Check the address (their website, their last letter), correct
          it on the organisation, and resend anything that mattered. Then say what you found.
        </p>
        <BounceList list={list} onDone={load} showComplaint />
      </div>
    </div>
  );
}

// The bounces on one complaint, at the top of its page.
export function BounceWarning({ list, onDone }) {
  if (!list?.length) return null;
  return (
    <div className="inline-note warn" style={{ marginBottom: 20 }}>
      <strong>An email bounced and did not arrive.</strong> The address may be wrong or no longer in
      use. Check it, correct it on the organisation, and resend anything that mattered.
      <BounceList list={list} onDone={onDone} />
    </div>
  );
}

function BounceList({ list, onDone, showComplaint = false }) {
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  async function resolve(b) {
    setBusy(b.id);
    setErr(null);
    try {
      await api.complaints.resolveBounce(b.id, notes[b.id] || '');
      await onDone?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      {err && <div className="login-error" style={{ margin: '8px 0' }}>{err}</div>}
      {list.map((b) => (
        <div key={b.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border, #e5e7eb)', marginTop: 6 }}>
          <div>
            <strong style={{ wordBreak: 'break-all' }}>{b.address}</strong>
            {b.org_name && <> · <Link to="/organisations">{b.org_name}</Link>’s complaints address</>}
            <span className="muted" style={{ fontSize: 12 }}> · bounced {formatDate(londonDay(b.bounced_at))}
              {b.source === 'smtp2go' ? ' (sent from the CRM)' : ' (sent from Outlook)'}</span>
          </div>
          {b.subject && <div className="muted" style={{ fontSize: 12 }}>Email: {b.subject}</div>}
          {b.reason && <div style={{ fontSize: 12 }}>Their server said: {b.reason}</div>}
          {showComplaint && b.complaint_id && (
            <div style={{ fontSize: 12 }}>
              About <Link to={`/complaints/${b.complaint_id}`}>{b.ref_code}</Link> {b.complaint_subject}
            </div>
          )}
          <div className="btn-row" style={{ marginTop: 6 }}>
            <input style={{ maxWidth: 360 }} value={notes[b.id] || ''}
              onChange={(e) => setNotes((n) => ({ ...n, [b.id]: e.target.value }))}
              placeholder="What you found, e.g. address corrected to …, resent" />
            <button className="btn btn-sm" disabled={busy === b.id || !(notes[b.id] || '').trim()} onClick={() => resolve(b)}>
              {busy === b.id ? 'Saving…' : 'Looked into it'}
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
