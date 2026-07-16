import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api, formatDate, ORG_TYPE_LABEL } from '../api';
import Modal from '../components/Modal.jsx';

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
  const [emailCfg, setEmailCfg] = useState({ enabled: false, mailbox: null });
  const [syncing, setSyncing] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const [ev, setEv] = useState({ event_date: today, type: 'chased', note: '' });

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

  const load = () => api.complaints.get(id).then(setC).catch((e) => setMsg(e.message));
  useEffect(() => {
    load();
    api.complaints.emailConfig().then(setEmailCfg).catch(() => {});
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
    await api.complaints.addEvent(id, {
      event_date: today,
      type: 'note',
      note: `AI draft — ${ai.email.subject}\n\n${ai.email.body}`,
    });
    await load();
    setMsg('Draft saved to the timeline.');
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
      const r = await api.complaints.sendEmail(id, send);
      setSend(null);
      if (r.complaint) setC((prev) => ({ ...prev, ...r.complaint }));
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
    if (!confirm('Remove this attachment?')) return;
    await api.complaints.removeAttachment(attId);
    await load();
  }

  async function syncEmails() {
    setSyncing(true);
    setMsg(null);
    try {
      const r = await api.complaints.fetchEmails();
      await load();
      setMsg(
        `Inbox synced — ${r.inserted} new email(s), ${r.matched} matched to a complaint` +
          (r.configured ? '.' : ' (using the dev inbox — Microsoft Graph not configured).'),
      );
    } catch (e) {
      setMsg(e.message);
    } finally {
      setSyncing(false);
    }
  }

  function copyRef() {
    if (c?.ref_code) navigator.clipboard?.writeText(c.ref_code).catch(() => {});
  }
  function copyAddress() {
    if (c?.email_address) navigator.clipboard?.writeText(c.email_address).catch(() => {});
  }

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

      {/* CC-to-log banner: this complaint's own unique address */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-body">
          <div className="flex-between" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>📧 Log emails to this complaint</div>
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                CC or BCC this complaint's own address into any email and it gets
                logged here automatically — no reference to type.
              </div>
            </div>
            <button className="btn-navy btn-sm" onClick={syncEmails} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync inbox'}
            </button>
          </div>

          <div
            className="flex-between"
            style={{
              gap: 10, alignItems: 'center', flexWrap: 'wrap',
              marginTop: 12, padding: '10px 12px',
              background: 'var(--surface-2, #f4f6f2)', borderRadius: 8,
            }}
          >
            <code
              style={{
                fontSize: 15, fontWeight: 600, wordBreak: 'break-all',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {c.email_address || '— (set COMPLAINT_EMAIL_DOMAIN)'}
            </code>
            {c.email_address && (
              <button className="btn btn-sm" onClick={copyAddress}>Copy address</button>
            )}
          </div>

          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Prefer a reference in the subject line instead? Use{' '}
            <strong>{c.ref_code}</strong>.{' '}
            <button
              className="btn-ghost btn-sm"
              style={{ padding: '0 4px' }}
              onClick={copyRef}
            >
              Copy ref
            </button>
          </div>
        </div>
      </div>

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

      {/* AI assistant */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <h2>✨ AI assistant</h2>
          {aiEnabled && (
            <button className="btn-navy btn-sm" onClick={runAssistant} disabled={aiBusy}>
              {aiBusy ? 'Working…' : ai ? 'Regenerate' : 'Analyse & draft next email'}
            </button>
          )}
        </div>
        <div className="card-body">
          {!aiEnabled ? (
            <div className="inline-note warn">
              The AI assistant isn’t configured yet — set <code>ANTHROPIC_API_KEY</code> in the
              server environment to enable it.
            </div>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
                It already sees this complaint’s stage, deadlines, timeline and logged emails. Add
                anything else below (paste an email you received, or say what you want the draft to
                do), then generate an analysis, next steps and a ready-to-send draft.
              </p>
              <div className="form-grid">
                <label className="field full">
                  <span className="lbl">What do you want to do? (optional)</span>
                  <input
                    value={aiInstruction}
                    onChange={(e) => setAiInstruction(e.target.value)}
                    placeholder="e.g. Escalate to Stage 2 citing their missed deadline"
                  />
                </label>
                <label className="field full">
                  <span className="lbl">Paste any extra info / emails (optional)</span>
                  <textarea
                    rows={4}
                    value={aiContext}
                    onChange={(e) => setAiContext(e.target.value)}
                    placeholder="Paste the latest reply from them, notes, or reference details…"
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
                            Send now
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

                  {ai.caution && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                      ⚠️ {ai.caution}
                    </div>
                  )}
                  <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                    Tip: CC this complaint’s address (<strong>{c.email_address}</strong>) when you
                    send, so the reply logs back here automatically.
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Escalation: deadlock detection + ombudsman referral pack */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <h2>⚖️ Escalation</h2>
          {aiEnabled && (
            <div className="btn-row">
              <button className="btn btn-sm" onClick={checkStatus} disabled={checking}>
                {checking ? 'Checking…' : 'Check if ready for ombudsman'}
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
              Set <code>ANTHROPIC_API_KEY</code> to enable deadlock detection and referral packs.
            </div>
          )}
          {c.ombudsman_ready && (
            <div className="inline-note warn" style={{ marginBottom: 8 }}>
              <strong>Flagged ready for the {c.rule?.ombudsman}.</strong> Their process looks
              exhausted or they’ve missed the deadline — you can refer now (by{' '}
              {formatDate(c.ombudsman_deadline)}).
            </div>
          )}
          {statusResult && (
            <div className="inline-note" style={{ background: 'var(--surface-2,#f4f6f2)' }}>
              <div>
                {statusResult.ombudsman_ready ? '✅ Ready to escalate. ' : '⏳ Not yet ombudsman-ready. '}
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
              Run a check to have the AI read the logged emails and tell you whether a final response
              or deadlock has landed and you can go to the ombudsman.
            </div>
          )}
        </div>
      </div>

      {/* Evidence attachments */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <h2>
            Evidence{' '}
            {c.attachments?.length > 0 && <span className="badge navy">{c.attachments.length}</span>}
          </h2>
          <label className="btn btn-sm" style={{ cursor: 'pointer', margin: 0 }}>
            {uploading ? 'Uploading…' : '+ Upload files'}
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
                      {a.has_text ? ' · text read for AI' : ''}
                    </div>
                  </td>
                  <td className="due" style={{ width: 120 }}>{formatDate((a.uploaded_at || '').slice(0, 10))}</td>
                  <td style={{ textAlign: 'right', width: 40 }}>
                    <button className="btn-ghost btn-sm" onClick={() => removeAttachment(a.id)}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            No evidence yet. Upload letters, PDFs, photos or portal screenshots — text files are read
            into the AI assistant automatically.
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
              {syncing ? 'Syncing…' : 'Sync inbox'}
            </button>
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
                    </div>
                    {em.body_preview && (
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                        {em.body_preview}
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className={`badge ${em.direction === 'outbound' ? 'navy' : 'grey'}`}>
                      {em.direction === 'outbound' ? 'sent' : em.match_method}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            No emails logged yet. CC or BCC{' '}
            <strong>{c.email_address || 'this complaint’s address'}</strong> into
            your emails and they’ll appear here after the next sync.
          </div>
        )}
      </div>

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
              placeholder="complaints@council.gov.uk" />
          </label>
          <label className="field">
            <span className="lbl">CC</span>
            <input value={send.cc} onChange={(e) => setSend({ ...send, cc: e.target.value })}
              placeholder="optional, comma-separated" />
          </label>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            This complaint’s address ({c.email_address}) is CC’d automatically so the thread logs here.
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
          title={`Referral pack — ${referral.ombudsman || 'ombudsman'}`}
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

function Info({ label, value }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 15 }}>{value}</div>
    </div>
  );
}
