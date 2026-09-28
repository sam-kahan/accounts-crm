import { useEffect, useState } from 'react';
import { api, formatDate } from '../api';

// Likely duplicates, each merged on one click: two complaints about the same
// issue, or one organisation saved under two names. Shown only when there is
// something to tidy. A merge moves every email, document and timeline entry,
// and the timeline records it.
export default function TidyUp({ refreshKey, onChanged }) {
  const [t, setT] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => api.complaints.tidy().then(setT).catch(() => setT(null));
  useEffect(() => { load(); }, [refreshKey]);

  if (!t || (!t.complaints.length && !t.organisations.length)) return null;

  async function merge(kind, keep, merge) {
    const what = kind === 'c'
      ? `Merge ${merge.ref_code} into ${keep.ref_code}? Its emails, documents and timeline move to ${keep.ref_code}, and ${merge.ref_code} is removed.`
      : `Merge “${merge.name}” into “${keep.name}”? Its complaints and documents move across, and the deadlines follow “${keep.name}”’s procedure.`;
    if (!confirm(what)) return;
    setBusy(merge.id);
    setErr(null);
    try {
      if (kind === 'c') await api.complaints.mergeComplaints(keep.id, merge.id);
      else await api.complaints.mergeOrganisations(keep.id, merge.id);
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 20, borderTop: '3px solid var(--green, #a2c533)' }}>
      <div className="card-head">
        <h2>Tidy up <span className="badge green">{t.complaints.length + t.organisations.length}</span></h2>
      </div>
      <div className="card-body">
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          These look like the same thing on file twice. Merging keeps everything and notes it on the timeline.
        </p>
        {err && <div className="inline-note warn" style={{ marginBottom: 8 }}>{err}</div>}
        {t.complaints.map(({ keep, merge: m }) => (
          <div key={`${keep.id}-${m.id}`} style={{ padding: '8px 0', borderTop: '1px solid var(--border, #e5e7eb)' }}>
            <div style={{ fontSize: 13 }}>
              <strong>Same issue?</strong> {keep.ref_code} “{keep.subject}” (raised {formatDate(keep.raised_on)}) and{' '}
              {m.ref_code} “{m.subject}” (raised {formatDate(m.raised_on)}), both against {keep.linked_org || keep.org_name}.
            </div>
            <button className="btn btn-sm" style={{ marginTop: 6 }} disabled={busy === m.id}
              onClick={() => merge('c', keep, m)}>
              {busy === m.id ? 'Merging…' : `Merge into ${keep.ref_code}`}
            </button>
          </div>
        ))}
        {t.organisations.map(({ keep, merge: m }) => (
          <div key={`${keep.id}-${m.id}`} style={{ padding: '8px 0', borderTop: '1px solid var(--border, #e5e7eb)' }}>
            <div style={{ fontSize: 13 }}>
              <strong>Same organisation?</strong> “{keep.name}”{keep.verified ? ' (procedure checked)' : ''} and “{m.name}”
              {m.complaint_count ? ` (${m.complaint_count} complaint${m.complaint_count === 1 ? '' : 's'})` : ''}.
            </div>
            <button className="btn btn-sm" style={{ marginTop: 6 }} disabled={busy === m.id}
              onClick={() => merge('o', keep, m)}>
              {busy === m.id ? 'Merging…' : `Merge into “${keep.name}”`}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
