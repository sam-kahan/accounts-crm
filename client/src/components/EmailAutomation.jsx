import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate } from '../api';
import { useAuth } from '../auth';

// ---------------------------------------------------------------------------
// The Complaints page's view of the email automation: whether it is working
// (and when it last looked), which mailboxes it watches, and finding past
// complaints to import. Everything here runs by itself every 5 minutes; the
// page only shows it and lets it be set up.
// ---------------------------------------------------------------------------

const ago = (iso) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  return formatDate(iso);
};

export default function EmailAutomation({ onChanged }) {
  const { canEdit } = useAuth();
  const isAdmin = canEdit('admin');
  const [a, setA] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(false);
  const [mailboxes, setMailboxes] = useState('');
  const [scanOpen, setScanOpen] = useState(false);
  const [scanBoxes, setScanBoxes] = useState('');
  const [cands, setCands] = useState([]);
  const [busyId, setBusyId] = useState(null);
  // Saving the watched mailboxes / starting a search: the button waits.
  const [saving, setSaving] = useState(null);

  const load = () =>
    api.complaints.automation().then((r) => { setA(r); setErr(null); return r; }).catch((e) => setErr(e.message));
  const loadCands = () => api.complaints.pastCandidates().then(setCands).catch(() => setCands([]));
  useEffect(() => { load(); loadCands(); }, []);

  // While a past-complaints search runs, or anything is being imported,
  // follow its progress.
  const importing = cands.some((c) => c.status === 'importing');
  const running = a?.past_scan?.status === 'running';
  useEffect(() => {
    if (!running && !importing) return undefined;
    // The list fills in (and, with automatic import, empties) as it reads.
    const t = setInterval(() => {
      load();
      loadCands();
      onChanged?.();
    }, 6000);
    return () => clearInterval(t);
  }, [running, importing]);

  if (!a) {
    return err ? (
      <div className="inline-note warn" style={{ marginBottom: 16 }}>
        Email status: {err}{' '}
        <button type="button" className="btn btn-sm" onClick={() => { load(); loadCands(); }}>Retry</button>
      </div>
    ) : null;
  }

  const lc = a.last_check;
  const stale = lc && Date.now() - new Date(lc.at).getTime() > 20 * 60000;
  let status;
  let tone = '';
  if (!a.mailbox_connected) {
    tone = 'warn';
    status = <>The mailbox connection isn’t set up on the server, so emails can’t be read automatically yet. Emails can still be uploaded to a complaint by hand.</>;
  } else if (!lc) {
    tone = 'warn';
    status = <>The automatic check hasn’t run yet. It runs every 5 minutes once the server’s schedule is installed.</>;
  } else if (stale) {
    tone = 'warn';
    status = <>The automatic check last ran {ago(lc.at)}, but it should run every 5 minutes. The server’s schedule may have stopped.</>;
  } else if (!lc.ok) {
    tone = 'warn';
    status = <>Last checked {ago(lc.at)}, with a problem: {lc.errors?.[0]}</>;
  } else {
    status = <>✓ New emails are checked every 5 minutes (only new ones, each read once). Last checked {ago(lc.at)}.</>;
  }

  async function saveWatched() {
    if (saving) return;
    setSaving('watched');
    setErr(null);
    try {
      const list = mailboxes.split(/[,\s;]+/).map((m) => m.trim()).filter(Boolean);
      await api.complaints.setWatched(list);
      setEditing(false);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(null);
    }
  }
  async function startScan() {
    if (saving) return;
    setSaving('scan');
    setErr(null);
    try {
      const list = scanBoxes.split(/[,\s;]+/).map((m) => m.trim()).filter(Boolean);
      await api.complaints.startPastScan(list, 12);
      setScanOpen(false);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(null);
    }
  }
  // Import and Link answer at once (the server claims the complaint, so a
  // second click can't bring it in twice) and carry on in the background; the
  // row shows "Bringing in its emails…" until it is done.
  async function decide(c, how, { quiet = false } = {}) {
    setBusyId(c.id);
    try {
      if (how === 'import') await api.complaints.importPast(c.id);
      else if (how === 'link') await api.complaints.linkPast(c.id, c.existing.id);
      else await api.complaints.skipPast(c.id);
    } catch (e) {
      // Quiet (Import all) hides only "already taken by its group": any other
      // failure is counted and said.
      if (!quiet) setErr(e.message);
      else if (e.status !== 409) return { failed: e.message };
    } finally {
      setBusyId(null);
      await loadCands();
      onChanged?.();
    }
    return null;
  }
  // Import all leaves out any that are already in the system: those are
  // linked one at a time, so nothing is duplicated.
  const fresh = cands.filter((c) => !c.existing && c.status !== 'importing');
  async function toggleAuto(on) {
    try {
      await api.complaints.setAutoImport(on);
      await load();
      setTimeout(() => { loadCands(); onChanged?.(); }, 4000);
    } catch (e) {
      setErr(e.message);
    }
  }
  async function importAll() {
    if (!confirm(`Import ${fresh.length}? Each one is created with its dates and emails.` +
      (cands.length > fresh.length ? ` (${cands.length - fresh.length} already in the system are left for you to link.)` : ''))) return;
    // Each import takes in the threads grouped with it, so a later one may
    // already be taken; that refusal is expected and not shown.
    setErr(null);
    const failed = [];
    for (const c of fresh) {
      // eslint-disable-next-line no-await-in-loop
      const r = await decide(c, 'import', { quiet: true });
      if (r?.failed) failed.push(r.failed);
    }
    if (failed.length) {
      setErr(`${failed.length === 1 ? '1 couldn’t' : `${failed.length} couldn’t`} be imported: ${[...new Set(failed)].join('; ')}. They are still on the list.`);
    }
  }

  const scan = a.past_scan || {};
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <div className={`inline-note ${tone}`} style={{ marginBottom: 10 }}>{status}</div>
          {err && <div className="inline-note warn" style={{ marginBottom: 10 }}>{err}</div>}
          <div style={{ fontSize: 13 }}>
            <strong>Watching:</strong>{' '}
            {a.watching.length ? a.watching.join(', ') : <span className="muted">no mailbox yet</span>}{' '}
            {!editing && isAdmin && (
              <button className="btn-ghost btn-sm" onClick={() => { setMailboxes(a.watching.join(', ') || 'accounts@greenco.co.uk'); setEditing(true); }}>
                Change
              </button>
            )}
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              Copy this mailbox in on complaint emails, as you already do. New complaints you send are
              set up automatically, and their replies are filed on the right complaint, with nothing to
              forward or copy.
            </div>
            {editing && (
              <div className="btn-row" style={{ marginTop: 8 }}>
                <input value={mailboxes} onChange={(e) => setMailboxes(e.target.value)} style={{ maxWidth: 420 }}
                  placeholder="accounts@greenco.co.uk" />
                <button className="btn-primary btn-sm" onClick={saveWatched} disabled={Boolean(saving)}>{saving === 'watched' ? 'Saving…' : 'Save'}</button>
                <button className="btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            )}
          </div>
          <div style={{ fontSize: 13, marginTop: 10 }}>
            <strong>Not sure which complaint an email is about?</strong> Forward it to{' '}
            <code style={{ wordBreak: 'break-all' }}>{a.inbox}</code> and the system works it out.
          </div>
          <div style={{ marginTop: 12 }}>
            {running ? (
              <div className="inline-note">
                Finding past complaints: {scan.stage}. {scan.threads ? `Read ${scan.read || 0} of ${scan.threads} new email threads,` : ''}{scan.skipped ? ` (${scan.skipped} read before, not read again)` : ''} found {scan.found || 0} so far.
              </div>
            ) : scanOpen ? (
              <div className="card" style={{ padding: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Find past complaints in email</div>
                <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
                  Searches these mailboxes for complaint emails, reads each thread, and lists the
                  complaints it finds for you to import or skip. Nothing is created until you choose.
                  It looks at the last 12 months only (an ombudsman won’t normally take anything older), and
                  never reads the same thread twice, so running it again only reads new threads.
                  {!isAdmin && ' You can search your own mailbox and the watched ones; an administrator can search others.'}
                </div>
                <div className="btn-row">
                  <input value={scanBoxes} onChange={(e) => setScanBoxes(e.target.value)} style={{ maxWidth: 380 }}
                    placeholder="accounts@greenco.co.uk, your.name@greenco.co.uk" />
                  <button className="btn-primary btn-sm" onClick={startScan} disabled={Boolean(saving) || !a.mailbox_connected || !a.ai}>{saving === 'scan' ? 'Starting…' : 'Start'}</button>
                  <button className="btn-ghost btn-sm" onClick={() => setScanOpen(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="btn btn-sm" disabled={!a.mailbox_connected || !a.ai}
                title={!a.mailbox_connected ? 'Needs the mailbox connection' : ''}
                onClick={() => { setScanBoxes(a.watching.join(', ') || 'accounts@greenco.co.uk'); setScanOpen(true); }}>
                🔎 Find past complaints in email
              </button>
            )}
            {scan.status === 'done' && !running && (
              <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
                Last search {ago(scan.finished_at)}: read {scan.read} new threads, found {scan.found}.
                {scan.skipped ? ` ${scan.skipped} thread${scan.skipped === 1 ? '' : 's'} read before were not read again.` : ''}
              </span>
            )}
            {scan.status === 'failed' && (
              <div className="inline-note warn" style={{ marginTop: 8 }}>The last search failed: {scan.error}</div>
            )}
          </div>
        </div>
      </div>

      {(cands.length > 0 || running) && (
        <div className="card" style={{ marginBottom: 20, borderTop: '3px solid var(--navy, #1e2235)' }}>
          <div className="card-body" style={{ paddingBottom: 0 }}>
            <label className="inline-note" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={Boolean(a.past_auto_import)} onChange={(e) => toggleAuto(e.target.checked)} style={{ marginTop: 3 }} />
              <span>
                <strong>Import automatically.</strong> Complaints the AI is sure of are imported as they’re
                found, each marked <em>To check</em> for a quick look. Ones it’s less sure of, and ones
                already in the system, wait here for you.
              </span>
            </label>
          </div>
          <div className="card-head">
            <h2>Past complaints found <span className="badge navy">{cands.length}</span></h2>
            {importing && <span className="muted" style={{ fontSize: 13 }}>Importing in the background. You can leave this page.</span>}
            {fresh.length > 0 && (
              <button className="btn-primary btn-sm" onClick={importAll} disabled={Boolean(busyId)}>
                Import all{cands.length > fresh.length ? ` ${fresh.length} new` : ''}
              </button>
            )}
          </div>
          <table>
            <tbody>
              {cands.map((c) => {
                const x = c.extracted || {};
                return (
                  <tr key={c.id}>
                    <td>
                      <strong>{x.subject || c.subject}</strong>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {x.org_name || 'Unknown organisation'}{x.property ? ` · ${x.property}` : ''}
                        {x.account_numbers?.length ? <> · <strong>Account {x.account_numbers.join(', ')}</strong></> : ''}
                      </div>
                      {x.summary && <div style={{ fontSize: 13, marginTop: 2 }}>{x.summary}</div>}
                      {c.existing && (
                        <div className="inline-note" style={{ marginTop: 6, fontSize: 12, padding: '6px 10px' }}>
                          <strong>Already in the system:</strong> {c.existing.ref_code}, {c.existing.subject}.
                          Link its emails there rather than importing it again.
                        </div>
                      )}
                      {!c.existing && c.org && !c.org.researched && (
                        <div className="inline-note warn" style={{ marginTop: 6, fontSize: 12, padding: '6px 10px' }}>
                          <strong>⚠ {c.org.name}’s complaints procedure hasn’t been researched{c.org.on_file ? '' : ' (it isn’t saved yet; importing sets it up with just its name)'}.</strong>{' '}
                          Imported now, its dates use the standard timescales until it is: research it on the{' '}
                          <Link to={c.org.id ? `/organisations?open=${c.org.id}` : '/organisations'}>Organisations</Link> page. The complaint stays flagged until then.
                        </div>
                      )}
                      {c.error && c.status !== 'importing' && (
                        <div className="inline-note warn" style={{ marginTop: 6, fontSize: 12, padding: '6px 10px' }}>{c.error}</div>
                      )}
                      {c.auto?.note && (
                        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                          {c.auto.will ? '⏳ ' : '👤 '}{c.auto.note}
                        </div>
                      )}
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                        Raised {formatDate(x.raised_on) } · {x.state === 'resolved' ? `resolved ${formatDate(x.resolved_on)}` : `open, at ${String(x.stage || 'stage_1').replace('_', ' ')}`}
                        {' '}· {c.message_count} email{c.message_count === 1 ? '' : 's'} · {x.confidence ? `${x.confidence} confidence` : ''}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {c.status === 'importing' ? (
                        <span className="muted" style={{ fontSize: 13 }}>Bringing in its emails…</span>
                      ) : c.existing ? (
                        <button className="btn-primary btn-sm" disabled={busyId === c.id} onClick={() => decide(c, 'link')}>
                          {busyId === c.id ? 'Linking…' : `Link emails to ${c.existing.ref_code}`}
                        </button>
                      ) : (
                        <button className="btn-primary btn-sm" disabled={busyId === c.id} onClick={() => decide(c, 'import')}>
                          {busyId === c.id ? 'Importing…' : 'Import'}
                        </button>
                      )}{' '}
                      {c.status !== 'importing' && (
                        <button className="btn-ghost btn-sm" disabled={busyId === c.id} onClick={() => decide(c, 'skip')}>Skip</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
