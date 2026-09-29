import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

// Re-check every open complaint against its emails (services/complaintRecheck.js):
// search by every account number and reference, read each complaint's emails
// together, and move it to where they show it has got to. Only started by a
// person (each complaint is an AI read). Folded away until wanted, and shows
// its progress and every result while it runs.
export default function RecheckAll({ onChanged }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.complaints.recheckStatus().then(setInfo).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const running = info?.run?.status === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => {
      api.complaints.recheckStatus().then((r) => {
        setInfo(r);
        if (r.run?.status !== 'running') { clearInterval(t); onChanged?.(); }
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!info) return err ? <div className="inline-note warn" style={{ marginBottom: 20 }}>{err}</div> : null;
  const run = info.run;

  async function start(force) {
    const n = info.open;
    const msg =
      `Re-check all ${n} open complaint${n === 1 ? '' : 's'}?\n\n` +
      'For each one: search the mailboxes for every account number and reference on it, read all its ' +
      'emails, and move it to the stage they show. Anything changed is noted on its timeline, can be ' +
      'undone, and is marked To check.\n\n' +
      (force
        ? 'Every complaint is read again, even with no new emails (one AI read each).'
        : 'Complaints with no new emails since their last re-check are not read again.');
    if (!confirm(msg)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.complaints.recheckAll(force);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const tone = { changed: 'amber', unchanged: 'grey', skipped: 'grey', failed: 'red' };
  const label = { changed: 'Changed', unchanged: 'No change', skipped: 'Nothing new', failed: 'Failed' };

  return (
    <details className="card" style={{ marginBottom: 20 }} open={running || undefined}>
      <summary style={{ cursor: 'pointer', padding: '14px 18px', fontWeight: 600 }}>
        Re-check every open complaint against its emails
        {running && <span className="badge amber" style={{ marginLeft: 8 }}>Running: {run.done} of {run.total}</span>}
        {!running && info.never_rechecked > 0 && (
          <span className="badge amber" style={{ marginLeft: 8 }}>{info.never_rechecked} never re-checked</span>
        )}
      </summary>
      <div className="card-body">
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          For each open complaint: the mailboxes are searched for every account number and reference
          on it and any email quoting one is filed on it; then all its emails are read together to
          see how far it has got, and its stage and dates are set from them. A stage only ever moves
          forward; a blank date is filled in; a recorded date that differs is left as it is and
          listed for you to check. A complaint with more than one organisation is read but not
          changed. Every change goes on the complaint’s timeline, can be undone on the complaint,
          and marks it To check.
        </p>
        {!info.ai && <div className="inline-note warn">The AI isn’t configured, so the emails can’t be read.</div>}
        {!info.mailbox && (
          <div className="inline-note warn" style={{ marginBottom: 8 }}>
            The mailbox connection isn’t set up, so only the emails already on file will be read.
          </div>
        )}
        {!running && info.never?.length > 0 && (
          <div className="inline-note warn" style={{ marginBottom: 10 }}>
            <strong>Never re-checked:</strong>
            <ul style={{ margin: '4px 0 4px 18px', padding: 0 }}>
              {info.never.map((c) => (
                <li key={c.id}>
                  <Link to={`/complaints/${c.id}`}>{c.ref_code}</Link> {c.org_name}{c.subject ? `: ${c.subject}` : ''}
                  <span className="muted"> ({c.why})</span>
                </li>
              ))}
            </ul>
            <span style={{ fontSize: 12 }}>
              To re-check {info.never.length === 1 ? 'it' : 'them'}, press Re-check all below: only complaints
              with something new are read (one AI read each), so the ones already done cost nothing. Or open
              {info.never.length === 1 ? ' it' : ' one'} and press “Re-check &amp; update next steps”.
            </span>
          </div>
        )}
        {err && <div className="inline-note warn" style={{ marginBottom: 8 }}>{err}</div>}
        <div className="btn-row" style={{ marginBottom: 10 }}>
          <button className="btn-primary btn-sm" disabled={busy || running || !info.ai || !info.open} onClick={() => start(false)}>
            {running ? 'Re-checking…' : `Re-check all ${info.open} open complaint${info.open === 1 ? '' : 's'}`}
          </button>
          {run && !running && (
            <button className="btn btn-sm" disabled={busy || !info.ai} onClick={() => start(true)}
              title="Read every complaint again, even those with no new emails">
              Re-check all again, including unchanged
            </button>
          )}
        </div>
        {run && (
          <>
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              {run.status === 'running' && <>Working through them: {run.done} of {run.total} done. </>}
              {run.status === 'finished' && <>Finished {new Date(run.finished_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}. </>}
              {run.status === 'interrupted' && <>Stopped part-way ({run.done} of {run.total}) by a restart. Run it again to finish; those already done are not read again. </>}
              {run.status === 'failed' && <>Stopped: {run.error}. </>}
              {run.changed} changed · {run.to_check} with something to check · {run.skipped} with nothing new · {run.failed} failed
            </div>
            {run.results?.length > 0 && (
              <table>
                <tbody>
                  {[...run.results].reverse().map((r) => (
                    <tr key={r.id}>
                      <td style={{ width: 120 }}>
                        <span className={`badge ${tone[r.result] || 'grey'}`}>{label[r.result] || r.result}</span>
                        {r.check && <div style={{ marginTop: 4 }}><span className="badge red">Check</span></div>}
                      </td>
                      <td>
                        {r.ref_code ? <Link to={`/complaints/${r.id}`}>{r.ref_code}</Link> : null} {r.org_name}{r.subject ? `: ${r.subject}` : ''}
                        <div className="muted" style={{ fontSize: 12 }}>{r.text}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </details>
  );
}
