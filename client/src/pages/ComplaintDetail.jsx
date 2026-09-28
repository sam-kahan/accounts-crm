import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, formatDate, todayISO, ORG_TYPE_LABEL } from '../api';
import Modal from '../components/Modal.jsx';

const STAGE_LABEL = {
  stage_1: 'Stage 1', stage_2: 'Stage 2', ombudsman: 'Ombudsman',
  resolved: 'Resolved', closed: 'Closed',
};
const EVENT_LABEL = {
  raised: 'Raised', acknowledged: 'Acknowledged', chased: 'Chased / sent',
  response_received: 'Response received', escalated: 'Escalated',
  resolved: 'Resolved', deadline_missed: 'Deadline missed', note: 'Note',
};
// How each checklist state reads, and its colour.
const STEP_STATE = {
  done: ['Done', 'ok'],
  overdue: ['Overdue', 'red'],
  missed: ['Missed', 'red'],
  due: ['Due', 'amber'],
  available: ['Available now', 'green'],
  upcoming: ['Later', 'grey'],
  pending: ['Not dated yet', 'grey'],
  past: ['—', 'grey'],
};
const EMAIL_KIND = {
  acknowledgement: 'Acknowledgement',
  stage1_response: 'Stage 1 response',
  final_response: 'Final response',
  holding_or_extension: 'Holding letter / extension',
  request_for_information: 'Request for information',
  our_email: 'Our email',
  other: 'Email',
};
const REVIEWED_AS = {
  acknowledgement: 'Their acknowledgement',
  response: 'Their response',
  correspondence: 'Correspondence',
  sent: 'Sent',
};

export default function ComplaintDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [c, setC] = useState(null);
  const [msg, setMsg] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const today = todayISO();
  const [ev, setEv] = useState({ event_date: today, type: 'note', note: '' });

  // AI assistant
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiContext, setAiContext] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [ai, setAi] = useState(null);
  // Send email, status check, referral pack, attachments
  const [send, setSend] = useState(null); // {to, cc, subject, body} when composing
  const [sending, setSending] = useState(false);
  const [statusResult, setStatusResult] = useState(null);
  const [checking, setChecking] = useState(false);
  const [referral, setReferral] = useState(null);
  const [referralBusy, setReferralBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  // A dated action (acknowledged / response / escalate / resolved) being recorded.
  const [action, setAction] = useState(null);
  const [editing, setEditing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  // The date to record for each new email, starting from what the AI read.
  const [emailDates, setEmailDates] = useState({});

  const load = () => {
    setLoadError(null);
    return api.complaints
      .get(id)
      .then(setC)
      .catch((e) => setLoadError(e.message));
  };
  useEffect(() => {
    load();
    api.complaints.aiConfig().then((r) => setAiEnabled(r.enabled)).catch(() => {});
  }, [id]);

  async function runAssistant() {
    setAiBusy(true);
    setMsg(null);
    try {
      const r = await api.complaints.assist(id, { instruction: aiInstruction, context: aiContext });
      setAi(r);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setAiBusy(false);
    }
  }
  function copyText(t) {
    if (t) navigator.clipboard?.writeText(t).catch(() => {});
  }
  async function saveDraftToTimeline() {
    if (!ai?.email) return;
    try {
      await api.complaints.addEvent(id, {
        event_date: today,
        type: 'note',
        note: `AI draft (not sent): ${ai.email.subject}\n\n${ai.email.body}`,
      });
      await load();
      setMsg('Draft saved to the timeline.');
    } catch (e) {
      setMsg(e.message);
    }
  }

  // Open the compose modal, optionally pre-filled from an AI draft.
  function openSend(draft) {
    setSend({
      to: c.org_email || '',
      cc: '',
      subject: draft?.subject || `Re: ${c.subject} [${c.ref_code}]`,
      body: draft?.body || '',
    });
  }
  async function doSend() {
    setSending(true);
    setMsg(null);
    try {
      await api.complaints.sendEmail(id, send);
      setSend(null);
      await load();
      setMsg('Email sent and logged to this complaint.');
    } catch (e) {
      setMsg(e.message);
    } finally {
      setSending(false);
    }
  }

  async function checkStatus() {
    setChecking(true);
    setMsg(null);
    try {
      const r = await api.complaints.checkStatus(id);
      setStatusResult(r);
      if (r.ombudsman_ready) await load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setChecking(false);
    }
  }

  async function buildReferral() {
    setReferralBusy(true);
    setMsg(null);
    try {
      setReferral(await api.complaints.referralPack(id));
    } catch (e) {
      setMsg(e.message);
    } finally {
      setReferralBusy(false);
    }
  }
  function downloadReferral() {
    if (!referral) return;
    const blob = new Blob([referral.text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `referral-${c.ref_code}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function uploadFiles(fileList) {
    if (!fileList?.length) return;
    setUploading(true);
    setMsg(null);
    try {
      await api.complaints.attachments(id, Array.from(fileList));
      await load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setUploading(false);
    }
  }
  async function removeAttachment(attId) {
    if (!confirm('Remove this document from the complaint? It will be deleted.')) return;
    setMsg(null);
    try {
      await api.complaints.removeAttachment(attId);
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  }

  async function syncEmails() {
    setSyncing(true);
    setMsg(null);
    try {
      const r = await api.complaints.fetchEmails();
      await load();
      setMsg(
        `Inbox checked: ${r.inserted} new email(s) logged` +
          (r.configured ? '.' : ' (test inbox only, as the mailbox connection isn’t configured).'),
      );
    } catch (e) {
      setMsg(e.message);
    } finally {
      setSyncing(false);
    }
  }

  async function reviewEmail(emailId, as, date) {
    setMsg(null);
    try {
      await api.complaints.reviewEmail(id, emailId, as, date);
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  }
  async function undoEmail(em) {
    if (!confirm('Undo what was recorded automatically from this email? It goes back to “New” for you to decide.')) return;
    setMsg(null);
    try {
      await api.complaints.undoEmail(id, em.id);
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  }
  async function refreshAiReview() {
    setReviewing(true);
    setMsg(null);
    try {
      setC(await api.complaints.refreshReview(id).then(() => api.complaints.get(id)));
    } catch (e) {
      setMsg(e.message);
    } finally {
      setReviewing(false);
    }
  }

  async function addEvent(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.complaints.addEvent(id, ev);
      setEv({ event_date: today, type: 'note', note: '' });
      await load();
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Record a dated step. The date matters — it can move their deadlines —
  // so it is always asked for, defaulting to today.
  async function recordAction({ date, note }) {
    const a = action;
    if (a.kind === 'escalate') await api.complaints.escalate(id, date);
    else await api.complaints.addEvent(id, { event_date: date, type: a.kind, note: note || a.defaultNote });
    setAction(null);
    await load();
  }

  async function remove() {
    if (!confirm('Delete this complaint, its timeline, emails and documents? This cannot be undone.')) return;
    try {
      await api.complaints.remove(id);
      navigate('/complaints');
    } catch (e) {
      setMsg(e.message);
    }
  }

  if (!c) {
    if (loadError) {
      return (
        <div className="card">
          <div className="inline-note warn" style={{ marginBottom: 12 }}>
            Couldn’t load this complaint: {loadError}
          </div>
          <div className="btn-row">
            <button className="btn-primary btn-sm" onClick={load}>Retry</button>
            <Link to="/complaints" className="btn btn-sm">← Complaints</Link>
          </div>
        </div>
      );
    }
    return <div className="spinner">Loading…</div>;
  }

  const open = c.state === 'open';
  const atStage = c.stage === 'stage_1' || c.stage === 'stage_2';
  const theOmb = /^the\s/i.test(c.rule?.ombudsman || '') ? c.rule.ombudsman : `the ${c.rule?.ombudsman}`;
  const newEmails = (c.emails || []).filter((e) => e.direction !== 'outbound' && !e.reviewed_at);
  const statusBadge =
    c.needs_chasing ? 'red' : c.status === 'responded' || c.status === 'resolved' ? 'ok' : 'amber';

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <Link to="/complaints" className="btn-ghost btn-sm">← Complaints</Link>
      </div>
      {msg && <div className="inline-note warn" style={{ marginBottom: 16 }}>{msg}</div>}

      {/* Where it stands, and what to do next */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <div>
            <h2 style={{ fontSize: 19 }}>{c.subject}</h2>
            <div className="muted" style={{ marginTop: 4 }}>
              {c.org_name} · {ORG_TYPE_LABEL[c.org_type] || c.org_type}
              {c.property && ` · ${c.property}`}
            </div>
          </div>
          <div className="btn-row">
            <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit details</button>
            <button className="btn-danger btn-sm" onClick={remove}>Delete</button>
          </div>
        </div>
        <div className="card-body">
          <div className="btn-row" style={{ marginBottom: 12 }}>
            <span className="badge navy">{STAGE_LABEL[c.stage]}</span>
            <span className={`badge ${statusBadge}`}>{c.label}</span>
            {c.imported && <span className="badge grey">Imported</span>}
          </div>

          {c.nextAction && (
            <div className={`inline-note ${c.needs_chasing ? 'warn' : ''}`} style={{ marginBottom: 14 }}>
              <strong>Next step:</strong> {c.nextAction}
            </div>
          )}

          <div className="form-grid">
            <Info label="Raised" value={formatDate(c.raised_on)} />
            <Info label="Our reference" value={c.ref_code} />
            <Info label="Their reference" value={c.reference || '—'} />
            <Info label="Sent by" value={c.channel || '—'} />
            <Info label="Email address for this complaint" value={
              <span style={{ wordBreak: 'break-all' }}>
                {c.email_address}{' '}
                <button className="btn-ghost btn-sm" style={{ padding: '0 4px' }} onClick={() => copyText(c.email_address)}>Copy</button>
              </span>
            } />
          </div>

          {open && (
            <div className="btn-row" style={{ marginTop: 4 }}>
              {c.stage === 'stage_1' && !c.acknowledged_on && !c.responded_on && (
                <button className="btn btn-sm" onClick={() => setAction({
                  kind: 'acknowledged', title: 'Record their acknowledgement',
                  intro: 'The date they acknowledged the complaint (the date on their email or letter).',
                  defaultNote: 'Acknowledged by the organisation',
                })}>
                  Record acknowledgement…
                </button>
              )}
              {atStage && !c.responded_on && (
                <button className="btn btn-sm" onClick={() => setAction({
                  kind: 'response_received',
                  title: c.stage === 'stage_2' ? 'Record their final (Stage 2) response' : 'Record their Stage 1 response',
                  intro: 'The date on their response. Upload the letter or email itself under Documents so it’s on file.',
                  defaultNote: c.stage === 'stage_2' ? 'Final (Stage 2) response received' : 'Stage 1 response received',
                })}>
                  Record their response…
                </button>
              )}
              {atStage && (
                <button className="btn-navy btn-sm" onClick={() => setAction({
                  kind: 'escalate',
                  title: c.stage === 'stage_1' ? 'Escalate to Stage 2' : `Refer to ${theOmb}`,
                  intro: c.stage === 'stage_1'
                    ? 'The date you asked them for Stage 2. Their Stage 2 deadline is counted from it.'
                    : `The date you referred the complaint to ${theOmb}.`,
                  noNote: true,
                })}>
                  {c.stage === 'stage_1' ? 'Escalate to Stage 2…' : 'Refer to ombudsman…'}
                </button>
              )}
              <button className="btn-primary btn-sm" onClick={() => setAction({
                kind: 'resolved', title: 'Mark the complaint resolved',
                intro: 'The date it was resolved, and the outcome. This is the record of how it ended.',
                defaultNote: 'Complaint resolved', noteLabel: 'Outcome',
              })}>
                Mark resolved…
              </button>
            </div>
          )}
        </div>
      </div>

      {/* The assistant's standing review */}
      {aiEnabled && (
        <div className="card" style={{ marginBottom: 20, borderTop: '3px solid var(--navy, #1e2235)' }}>
          <div className="card-head">
            <h2>✨ AI review</h2>
            <div className="btn-row">
              {c.ai_reviewed_at && (
                <span className="muted" style={{ fontSize: 12 }}>
                  Updated {new Date(c.ai_reviewed_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
              )}
              <button className="btn btn-sm" onClick={refreshAiReview} disabled={reviewing}>
                {reviewing ? 'Reviewing…' : 'Refresh'}
              </button>
            </div>
          </div>
          <div className="card-body">
            {!c.ai_review ? (
              <div className="muted" style={{ fontSize: 13 }}>
                {c.ai_review_error
                  ? <>The last review failed ({c.ai_review_error}). Press Refresh to try again.</>
                  : <>The assistant reviews each complaint automatically after every change. Press Refresh to review it now.</>}
              </div>
            ) : (
              <>
                <p style={{ marginTop: 0 }}>{c.ai_review.summary}</p>
                {c.ai_review.recommended_action && (
                  <div className="inline-note warn" style={{ marginBottom: 10 }}>
                    <strong>Recommended next step:</strong> {c.ai_review.recommended_action}
                  </div>
                )}
                {c.ai_review.steps?.length > 0 && (
                  <ol style={{ margin: '0 0 10px', paddingLeft: 20 }}>
                    {c.ai_review.steps.map((st, i) => <li key={i} style={{ marginBottom: 4 }}>{st}</li>)}
                  </ol>
                )}
                {c.ai_review.caution && (
                  <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
                    <strong>Check:</strong> {c.ai_review.caution}
                  </div>
                )}
                {c.ai_review.email?.body && (
                  <details>
                    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                      Draft email ready: {c.ai_review.email.subject}
                    </summary>
                    <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.5, margin: '8px 0' }}>
                      {c.ai_review.email.body}
                    </pre>
                    <div className="btn-row">
                      <button className="btn btn-sm"
                        onClick={() => copyText(`Subject: ${c.ai_review.email.subject}\n\n${c.ai_review.email.body}`)}>
                        Copy
                      </button>
                      <button className="btn-primary btn-sm" onClick={() => openSend(c.ai_review.email)}>
                        Review &amp; send…
                      </button>
                    </div>
                  </details>
                )}
                <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                  Written by AI from this complaint’s procedure, emails and documents. Check any
                  figure or date against the documents before relying on it. Nothing is sent
                  unless you press Send.
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Emails that arrived and haven't been looked at */}
      {newEmails.length > 0 && (
        <div className="card" style={{ marginBottom: 20, borderTop: '3px solid var(--warn)' }}>
          <div className="card-head">
            <h2>New email{newEmails.length === 1 ? '' : 's'} to review <span className="badge amber">{newEmails.length}</span></h2>
          </div>
          <div className="card-body">
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
              These need a quick check. Confirm what each one is and the date on their email. The
              deadlines update from that date.
            </p>
            {newEmails.map((em) => {
              const a = em.analysis;
              const arrived = (em.received_at || '').slice(0, 10);
              const date = emailDates[em.id] ?? (a?.sent_on || arrived);
              return (
                <div key={em.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border, #e5e7eb)' }}>
                  <strong>{em.subject || '(no subject)'}</strong>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {em.sender_name || em.sender_email} · arrived {formatDate(arrived)}
                  </div>
                  {a ? (
                    <div className="inline-note" style={{ marginTop: 6 }}>
                      <strong>AI reads this as:</strong> {EMAIL_KIND[a.kind] || 'Email'}
                      {a.author && <> from {a.author}</>}
                      {a.sent_on && <>, sent {formatDate(a.sent_on)}</>}
                      {a.forwarded && ' (forwarded)'}. {a.summary}
                      {a.confidence !== 'high' && <div style={{ fontSize: 12, marginTop: 2 }}>Not certain ({a.confidence} confidence), so please check.</div>}
                    </div>
                  ) : (
                    em.body_preview && <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{em.body_preview}</div>
                  )}
                  <div className="btn-row" style={{ marginTop: 8, alignItems: 'flex-end' }}>
                    <label className="field" style={{ margin: 0, maxWidth: 180 }}>
                      <span className="lbl" style={{ fontSize: 12 }}>Date on their email</span>
                      <input type="date" value={date} max={today}
                        onChange={(e) => setEmailDates((d) => ({ ...d, [em.id]: e.target.value }))} />
                    </label>
                    {c.stage === 'stage_1' && !c.acknowledged_on && (
                      <button className={`btn btn-sm ${a?.kind === 'acknowledgement' ? 'btn-primary' : ''}`}
                        onClick={() => reviewEmail(em.id, 'acknowledgement', date)}>
                        Their acknowledgement
                      </button>
                    )}
                    {atStage && (
                      <button className={`btn btn-sm ${a?.kind === 'stage1_response' || a?.kind === 'final_response' ? 'btn-primary' : ''}`}
                        onClick={() => reviewEmail(em.id, 'response', date)}>
                        Their {c.stage === 'stage_2' ? 'final' : 'Stage 1'} response
                      </button>
                    )}
                    <button className="btn-ghost btn-sm" onClick={() => reviewEmail(em.id, 'correspondence', date)}>
                      Just correspondence
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Their procedure, step by step */}
      <ProcedureCard c={c} />

      {/* Documents */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <h2>
            Documents{' '}
            {c.attachments?.length > 0 && <span className="badge navy">{c.attachments.length}</span>}
          </h2>
          <label className="btn btn-sm" style={{ cursor: 'pointer', margin: 0 }}>
            {uploading ? 'Uploading…' : '+ Upload'}
            <input
              type="file"
              multiple
              style={{ display: 'none' }}
              disabled={uploading}
              onChange={(e) => uploadFiles(e.target.files)}
            />
          </label>
        </div>
        {c.attachments?.length ? (
          <table>
            <tbody>
              {c.attachments.map((a) => (
                <tr key={a.id}>
                  <td>
                    <a href={api.complaints.attachmentUrl(a.id)} target="_blank" rel="noreferrer">
                      {a.filename}
                    </a>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {(a.size_bytes / 1024).toFixed(0)} KB
                      {a.source_email_id ? ' · attached to an email' : ''}
                      {a.ai_readable ? ' · read by the AI assistant' : ' · not readable by the AI'}
                    </div>
                  </td>
                  <td className="due" style={{ width: 120 }}>{formatDate((a.uploaded_at || '').slice(0, 10))}</td>
                  <td style={{ textAlign: 'right', width: 40 }}>
                    <button
                      className="btn-ghost btn-sm"
                      aria-label={`Remove document ${a.filename}`}
                      onClick={() => removeAttachment(a.id)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            No documents yet. Upload the letters, emails (saved as PDF), statements and photos. Every
            one is kept here as the record, and PDFs, photos, Word and text files are read by the AI
            assistant.
          </div>
        )}
      </div>

      {/* Emails */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <h2>
            Emails{' '}
            {c.emails?.length > 0 && <span className="badge navy">{c.emails.length}</span>}
          </h2>
          <div className="btn-row">
            <button className="btn-primary btn-sm" onClick={() => openSend(null)}>Compose</button>
            <button className="btn btn-sm" onClick={syncEmails} disabled={syncing}>
              {syncing ? 'Checking…' : 'Check inbox now'}
            </button>
          </div>
        </div>
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <div className="inline-note" style={{ marginBottom: 12 }}>
            <strong>This complaint’s email address:</strong>{' '}
            <code style={{ fontWeight: 600, wordBreak: 'break-all' }}>{c.email_address}</code>{' '}
            <button className="btn-ghost btn-sm" onClick={() => copyText(c.email_address)}>Copy</button>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              Forward anything about this complaint to it, and copy it in whenever you email
              them, so their replies arrive here by themselves. Each email is read in full, its
              attachments saved, and their acknowledgement or response recorded on the date they
              sent it.
            </div>
          </div>
        </div>
        {c.emails?.length ? (
          <table>
            <tbody>
              {c.emails.map((em) => (
                <tr key={em.id}>
                  <td className="due" style={{ width: 120 }}>
                    {formatDate((em.received_at || '').slice(0, 10))}
                  </td>
                  <td>
                    <strong>{em.subject || '(no subject)'}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {em.sender_name || em.sender_email}
                      {em.analysis?.forwarded && em.analysis?.author && <> · forwarded, originally from {em.analysis.author}</>}
                      {em.analysis?.sent_on && <> · sent {formatDate(em.analysis.sent_on)}</>}
                    </div>
                    {em.analysis?.summary ? (
                      <div style={{ fontSize: 13, marginTop: 2 }}>{em.analysis.summary}</div>
                    ) : em.body_preview && (
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{em.body_preview}</div>
                    )}
                    {em.applied && (
                      <div className="inline-note" style={{ marginTop: 6, fontSize: 12, padding: '6px 10px' }}>
                        Recorded automatically
                        {em.applied.after?.acknowledged_on && <>: acknowledged {formatDate(em.applied.after.acknowledged_on)}</>}
                        {em.applied.after?.responded_on && <>: responded {formatDate(em.applied.after.responded_on)}</>}
                        {em.applied.after?.reference && <> · their reference {em.applied.after.reference}</>}
                        .{' '}
                        <button className="btn-ghost btn-sm" style={{ padding: '0 4px' }} onClick={() => undoEmail(em)}>Undo</button>
                      </div>
                    )}
                    {em.body_text && (
                      <details style={{ marginTop: 4 }}>
                        <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>Show the full email</summary>
                        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, margin: '6px 0' }}>{em.body_text}</pre>
                      </details>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {em.direction === 'outbound' ? (
                      <span className="badge navy">Sent</span>
                    ) : em.reviewed_at ? (
                      <span className="badge grey" title={em.reviewed_by ? `Marked by ${em.reviewed_by}` : ''}>
                        {em.analysis?.kind === 'our_email' ? 'Our email' : REVIEWED_AS[em.reviewed_as] || 'Reviewed'}
                      </span>
                    ) : (
                      <span className="badge amber">New</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No emails logged yet.</div>
        )}
      </div>

      {/* Timeline */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head"><h2>Timeline</h2></div>
        <div className="card-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            The full record: every step, email and correction, with who recorded it. Add phone calls
            and anything else that happened here.
          </p>
          <form onSubmit={addEvent} className="form-grid" style={{ alignItems: 'end' }}>
            <label className="field">
              <span className="lbl">Date</span>
              <input type="date" value={ev.event_date} onChange={(e) => setEv({ ...ev, event_date: e.target.value })} required />
            </label>
            <label className="field">
              <span className="lbl">What happened</span>
              <select value={ev.type} onChange={(e) => setEv({ ...ev, type: e.target.value })}>
                <option value="note">Note (e.g. a phone call)</option>
                <option value="chased">Chased them</option>
                <option value="deadline_missed">They missed a deadline</option>
              </select>
            </label>
            <label className="field full">
              <span className="lbl">Details</span>
              <input value={ev.note} onChange={(e) => setEv({ ...ev, note: e.target.value })}
                placeholder="Who you spoke to, what was said or agreed" />
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
                    <td className="due" style={{ width: 120 }}>{formatDate(e.event_date)}</td>
                    <td style={{ width: 150 }}><span className="badge grey">{EVENT_LABEL[e.type] || e.type}</span></td>
                    <td style={{ whiteSpace: 'pre-wrap' }}>
                      {e.note}
                      {e.created_by && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {e.created_by} · {new Date(e.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">No events yet.</div>
          )}
        </div>
      </div>

      {/* AI assistant */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <h2>Ask the assistant</h2>
          {aiEnabled && (
            <button className="btn-navy btn-sm" onClick={runAssistant} disabled={aiBusy}>
              {aiBusy ? 'Working…' : ai ? 'Regenerate' : 'Analyse & draft next email'}
            </button>
          )}
        </div>
        <div className="card-body">
          {!aiEnabled ? (
            <div className="inline-note warn">
              The AI assistant isn’t configured yet. Set <code>ANTHROPIC_API_KEY</code> in the
              server environment to enable it.
            </div>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
                It reads this complaint’s procedure, deadlines, timeline, emails and documents, and
                drafts the next email. Nothing is sent until you press Send. Always check the
                facts and figures in a draft against the documents first.
              </p>
              <div className="form-grid">
                <label className="field full">
                  <span className="lbl">What do you want to do? (optional)</span>
                  <input
                    value={aiInstruction}
                    onChange={(e) => setAiInstruction(e.target.value)}
                    placeholder="e.g. Chase for the acknowledgement they haven’t sent"
                  />
                </label>
                <label className="field full">
                  <span className="lbl">Anything else it should know? (optional)</span>
                  <textarea
                    rows={3}
                    value={aiContext}
                    onChange={(e) => setAiContext(e.target.value)}
                    placeholder="Paste a reply from them, or notes from a phone call…"
                  />
                </label>
              </div>

              {ai && (
                <div style={{ marginTop: 12 }}>
                  <div className="inline-note" style={{ background: 'var(--surface-2,#f4f6f2)' }}>
                    <strong>Analysis.</strong> {ai.summary}
                  </div>
                  {ai.recommended_action && (
                    <div className="inline-note warn" style={{ marginTop: 8 }}>
                      <strong>Recommended:</strong> {ai.recommended_action}
                    </div>
                  )}
                  {ai.steps?.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      <div className="lbl">Next steps</div>
                      <ol style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                        {ai.steps.map((s, i) => (
                          <li key={i} style={{ marginBottom: 4 }}>{s}</li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {ai.caution && (
                    <div className="inline-note warn" style={{ marginTop: 10 }}>
                      <strong>Check before sending:</strong> {ai.caution}
                    </div>
                  )}

                  {ai.email && (
                    <div className="card" style={{ marginTop: 14 }}>
                      <div className="card-head">
                        <h2 style={{ fontSize: 15 }}>Draft email</h2>
                        <div className="btn-row">
                          <button
                            className="btn btn-sm"
                            onClick={() => copyText(`Subject: ${ai.email.subject}\n\n${ai.email.body}`)}
                          >
                            Copy
                          </button>
                          <button className="btn btn-sm" onClick={saveDraftToTimeline}>
                            Save to timeline
                          </button>
                          <button className="btn-primary btn-sm" onClick={() => openSend(ai.email)}>
                            Review &amp; send…
                          </button>
                        </div>
                      </div>
                      <div className="card-body">
                        <div className="muted" style={{ fontSize: 12, fontWeight: 600 }}>SUBJECT</div>
                        <div style={{ marginBottom: 10, fontWeight: 600 }}>{ai.email.subject}</div>
                        <div className="muted" style={{ fontSize: 12, fontWeight: 600 }}>BODY</div>
                        <pre
                          style={{
                            whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 14,
                            margin: '4px 0 0', lineHeight: 1.5,
                          }}
                        >
                          {ai.email.body}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Escalation: deadlock detection + ombudsman referral pack */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <h2>⚖️ Ombudsman</h2>
          {aiEnabled && (
            <div className="btn-row">
              <button className="btn btn-sm" onClick={checkStatus} disabled={checking}>
                {checking ? 'Checking…' : 'Check if ready for the ombudsman'}
              </button>
              <button className="btn-navy btn-sm" onClick={buildReferral} disabled={referralBusy}>
                {referralBusy ? 'Building…' : 'Build referral pack'}
              </button>
            </div>
          )}
        </div>
        <div className="card-body">
          {!aiEnabled && (
            <div className="muted" style={{ fontSize: 13 }}>
              Set <code>ANTHROPIC_API_KEY</code> to enable the readiness check and referral packs.
            </div>
          )}
          {c.ombudsman_ready && (
            <div className="inline-note warn" style={{ marginBottom: 8 }}>
              <strong>Flagged ready for {theOmb}.</strong> Their process looks exhausted or they’ve
              missed the deadline.
              {c.ombudsman_deadline && <> Refer by {formatDate(c.ombudsman_deadline)}.</>}
            </div>
          )}
          {statusResult && (
            <div className="inline-note" style={{ background: 'var(--surface-2,#f4f6f2)' }}>
              <div>
                {statusResult.ombudsman_ready ? '✅ Ready to escalate. ' : '⏳ Not yet ready. '}
                {statusResult.reason}
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Final response: {statusResult.final_response ? 'yes' : 'no'} · Deadlock:{' '}
                {statusResult.deadlock ? 'yes' : 'no'} · Suggested next: {statusResult.suggested_next_stage}
              </div>
            </div>
          )}
          {aiEnabled && !statusResult && !c.ombudsman_ready && (
            <div className="muted" style={{ fontSize: 13 }}>
              The checklist above shows when a referral becomes possible. The check reads the
              emails and documents for a final response or deadlock letter as well.
            </div>
          )}
        </div>
      </div>

      {action && (
        <DatedActionModal action={action} onClose={() => setAction(null)} onSubmit={recordAction} />
      )}

      {editing && (
        <EditComplaintModal
          c={c}
          onClose={() => setEditing(false)}
          onSaved={async () => { setEditing(false); await load(); }}
        />
      )}

      {/* Compose / send modal */}
      {send && (
        <Modal
          title="Send email"
          onClose={() => setSend(null)}
          footer={
            <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setSend(null)}>Cancel</button>
              <button
                className="btn-primary"
                onClick={doSend}
                disabled={sending || !send.to || !send.subject || !send.body}
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          }
        >
          <label className="field">
            <span className="lbl">To *</span>
            <input value={send.to} onChange={(e) => setSend({ ...send, to: e.target.value })}
              placeholder="complaints@example.co.uk" />
          </label>
          <label className="field">
            <span className="lbl">CC</span>
            <input value={send.cc} onChange={(e) => setSend({ ...send, cc: e.target.value })}
              placeholder="optional, comma-separated" />
          </label>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            This complaint’s address ({c.email_address}) is copied in automatically so their reply
            logs here.
          </div>
          <label className="field">
            <span className="lbl">Subject *</span>
            <input value={send.subject} onChange={(e) => setSend({ ...send, subject: e.target.value })} />
          </label>
          <label className="field">
            <span className="lbl">Message *</span>
            <textarea rows={12} value={send.body}
              onChange={(e) => setSend({ ...send, body: e.target.value })} />
          </label>
        </Modal>
      )}

      {/* Referral pack modal */}
      {referral && (
        <Modal
          title={`Referral pack: ${referral.ombudsman || 'ombudsman'}`}
          onClose={() => setReferral(null)}
          footer={
            <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => copyText(referral.text)}>Copy</button>
              <button className="btn-primary" onClick={downloadReferral}>Download .txt</button>
            </div>
          }
        >
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5, margin: 0 }}>
            {referral.text}
          </pre>
        </Modal>
      )}
    </>
  );
}

// The organisation's procedure as a checklist, with how far it can be trusted.
function ProcedureCard({ c }) {
  const p = c.procedure;
  const defaulted = c.rule?.defaulted || [];
  const timingDefaults = ['ackDays', 'stage1Days', 'stage2Days'].filter((k) => defaulted.includes(k));

  let trust;
  if (!p) {
    trust = (
      <div className="inline-note warn" style={{ marginBottom: 12 }}>
        <strong>These dates use general timescales for a {c.rule?.label?.toLowerCase() || 'body like this'}.</strong>{' '}
        Link this complaint to the organisation (Edit details) and add their own procedure on the{' '}
        <Link to="/organisations">Organisations</Link> page, so the dates follow their rules.
      </div>
    );
  } else if (p.verified_at) {
    trust = (
      <div className="inline-note" style={{ marginBottom: 12 }}>
        ✓ Dates follow {p.procedure_ref ? <strong>{p.procedure_ref}</strong> : 'their procedure'} —
        checked by {p.verified_by || 'a colleague'} on {formatDate(String(p.verified_at).slice(0, 10))}.
        {timingDefaults.length > 0 && ' Some timescales aren’t stated in it and use the general default, marked below.'}
      </div>
    );
  } else {
    trust = (
      <div className="inline-note warn" style={{ marginBottom: 12 }}>
        <strong>Not checked yet.</strong> These dates come from{' '}
        {p.research_status === 'document' ? 'their procedure document, read by the AI'
          : p.research_status === 'researched' ? 'AI research of their website'
          : 'details entered for this organisation'}
        {' '}and nobody has confirmed them against their procedure. Open{' '}
        <Link to="/organisations">{p.name}</Link>, check each figure against the document, and tick
        “checked”.
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-head">
        <h2>Their complaints procedure, step by step</h2>
        {p?.procedure_ref && <span className="badge navy">{p.procedure_ref}</span>}
      </div>
      <div className="card-body" style={{ paddingBottom: 0 }}>{trust}</div>
      <table>
        <tbody>
          {(c.steps || []).map((s) => {
            const [label, tone] = STEP_STATE[s.state] || [s.state, 'grey'];
            return (
              <tr key={s.key}>
                <td style={{ width: 210 }}><strong>{s.label}</strong></td>
                <td className={`due ${s.state === 'overdue' ? 'overdue' : ''}`} style={{ width: 120 }}>
                  {s.date ? formatDate(s.date) : '—'}
                </td>
                <td style={{ width: 120 }}><span className={`badge ${tone}`}>{label}</span></td>
                <td className="muted" style={{ fontSize: 13 }}>{s.note}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="card-body">
        {p?.procedure_summary && (
          <details style={{ marginBottom: 8 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>How their procedure works</summary>
            <p style={{ whiteSpace: 'pre-wrap' }}>{p.procedure_summary}</p>
          </details>
        )}
        {c.rule?.legalBasis && (
          <details>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Ombudsman and the law</summary>
            <p>{c.rule.legalBasis}</p>
            <p className="muted" style={{ fontSize: 13 }}>
              Ombudsman:{' '}
              {c.rule.ombudsmanUrl
                ? <a href={c.rule.ombudsmanUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--green-600)' }}>{c.rule.ombudsman}</a>
                : c.rule.ombudsman}
            </p>
            {p?.sources?.length > 0 && (
              <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 13 }}>
                {p.sources.map((s, i) => (
                  <li key={i}><a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--green-600)' }}>{s.title || s.url}</a></li>
                ))}
              </ul>
            )}
          </details>
        )}
      </div>
    </div>
  );
}

// Record a step with the date it actually happened.
function DatedActionModal({ action, onClose, onSubmit }) {
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(e) {
    e.preventDefault();
    if (date > todayISO()) { setError('That date is in the future.'); return; }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ date, note: note.trim() });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={action.title} onClose={onClose}>
      {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}
      <form onSubmit={save}>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>{action.intro}</p>
        <label className="field">
          <span className="lbl">Date *</span>
          <input type="date" required value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
        </label>
        {!action.noNote && (
          <label className="field">
            <span className="lbl">{action.noteLabel || 'Note (optional)'}</span>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder={action.defaultNote} />
          </label>
        )}
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Correct the details. Every change is written to the timeline by the server.
function EditComplaintModal({ c, onClose, onSaved }) {
  const [orgs, setOrgs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({
    organisation_id: c.organisation_id || '',
    org_name: c.org_name || '',
    org_type: c.org_type || 'other',
    subject: c.subject || '',
    property: c.property || '',
    category: c.category || '',
    channel: c.channel || 'email',
    reference: c.reference || '',
    our_reference: c.our_reference || '',
    raised_on: c.raised_on || '',
    stage_started_on: c.stage_started_on || '',
    acknowledged_on: c.acknowledged_on || '',
    responded_on: c.responded_on || '',
    final_response_on: c.final_response_on || '',
    due_override: c.response_due_manual ? c.response_due || '' : '',
    description: c.description || '',
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  useEffect(() => { api.organisations.list().then(setOrgs).catch(() => setOrgs([])); }, []);

  function pickOrg(orgId) {
    const org = orgs.find((o) => o.id === orgId);
    setForm((f) => ({
      ...f,
      organisation_id: orgId,
      org_name: org ? org.name : f.org_name,
      org_type: org ? org.type : f.org_type,
    }));
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const blank = (v) => (v === '' ? null : v);
    // Only send an override if it was changed, so saving other details never
    // hands a date someone typed in (or left empty on purpose) back to the rules.
    const initialOverride = c.response_due_manual ? c.response_due || '' : '';
    try {
      await api.complaints.update(c.id, {
        organisation_id: blank(form.organisation_id),
        org_name: form.org_name,
        org_type: form.org_type,
        subject: form.subject,
        property: blank(form.property),
        category: blank(form.category),
        channel: form.channel,
        reference: blank(form.reference),
        our_reference: blank(form.our_reference),
        raised_on: form.raised_on,
        // Stage 1 starts the day it was raised (the server keeps the two together).
        stage_started_on: c.stage === 'stage_1' ? undefined : blank(form.stage_started_on),
        acknowledged_on: blank(form.acknowledged_on),
        responded_on: blank(form.responded_on),
        final_response_on: blank(form.final_response_on),
        response_due: form.due_override === initialOverride ? undefined : blank(form.due_override),
        description: blank(form.description),
      });
      await onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const dateField = (k, label, hint) => (
    <label className="field">
      <span className="lbl">{label}</span>
      <input type="date" value={form[k]} onChange={(e) => set(k, e.target.value)} />
      {hint && <span className="muted" style={{ fontSize: 12 }}>{hint}</span>}
    </label>
  );

  return (
    <Modal title="Edit complaint details" onClose={onClose}>
      {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Every change is recorded on the timeline with the old and new value. The deadlines are
        recalculated from these dates.
      </p>
      <form onSubmit={save}>
        <label className="field">
          <span className="lbl">Organisation (its procedure sets the deadlines)</span>
          <select value={form.organisation_id} onChange={(e) => pickOrg(e.target.value)}>
            <option value="">— Not linked (general timescales) —</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <div className="form-grid">
          <label className="field">
            <span className="lbl">Organisation name *</span>
            <input required value={form.org_name} onChange={(e) => set('org_name', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Type</span>
            <select value={form.org_type} disabled={Boolean(form.organisation_id)}
              onChange={(e) => set('org_type', e.target.value)}>
              {Object.entries(ORG_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="field full">
            <span className="lbl">Subject *</span>
            <input required value={form.subject} onChange={(e) => set('subject', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Property / address</span>
            <input value={form.property} onChange={(e) => set('property', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Category</span>
            <input value={form.category} onChange={(e) => set('category', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Their reference</span>
            <input value={form.reference} onChange={(e) => set('reference', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Our own reference</span>
            <input value={form.our_reference} onChange={(e) => set('our_reference', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Sent by</span>
            <select value={form.channel} onChange={(e) => set('channel', e.target.value)}>
              <option value="email">Email</option>
              <option value="portal">Online portal</option>
              <option value="phone">Phone</option>
              <option value="letter">Letter</option>
              <option value="other">Other</option>
            </select>
          </label>
          {dateField('raised_on', 'Date complaint made *')}
          {c.stage !== 'stage_1' && dateField('stage_started_on', 'Stage 2 requested on', 'Their Stage 2 deadline counts from this')}
          {dateField('acknowledged_on', 'They acknowledged on')}
          {dateField('responded_on', `They responded on (${STAGE_LABEL[c.stage] || 'current stage'})`)}
          {dateField('final_response_on', 'Their final response', 'The referral window often counts from this')}
          {dateField('due_override', 'Response due (override)', 'Leave blank to use their procedure (recommended)')}
          <label className="field full">
            <span className="lbl">Details</span>
            <textarea value={form.description} onChange={(e) => set('description', e.target.value)} />
          </label>
        </div>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </form>
    </Modal>
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
