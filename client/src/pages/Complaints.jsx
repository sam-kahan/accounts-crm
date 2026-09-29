import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { accountOrReference, api, formatDate, todayISO, londonDay, ORG_TYPE_LABEL } from '../api';
import Modal from '../components/Modal.jsx';
import EmailAutomation from '../components/EmailAutomation.jsx';
import TidyUp from '../components/TidyUp.jsx';
import BouncedEmails from '../components/BouncedEmails.jsx';
import RecheckAll from '../components/RecheckAll.jsx';

const STAGE_LABEL = {
  stage_1: 'Stage 1',
  stage_2: 'Stage 2',
  ombudsman: 'Ombudsman',
  resolved: 'Resolved',
  closed: 'Closed',
};

function StatusBadge({ c }) {
  if (c.needs_chasing) return <span className="badge red">{c.label}</span>;
  if (c.status === 'responded') return <span className="badge ok">Response received</span>;
  if (c.status === 'resolved') return <span className="badge ok">Resolved</span>;
  if (c.status === 'closed') return <span className="badge grey">Closed</span>;
  return <span className="badge amber">{c.label}</span>;
}

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

// Match a name the AI read to a saved organisation, through the usual noise
// (Ltd/Limited, punctuation, "the"). Only an exact match after cleaning counts —
// a half-right guess would apply another body's procedure.
function orgKey(name) {
  return String(name || '').toLowerCase()
    .replace(/&/g, ' and ').replace(/\blimited\b/g, 'ltd').replace(/\bthe\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function matchOrg(orgs, name) {
  const k = orgKey(name);
  if (!k) return null;
  return orgs.find((o) => orgKey(o.name) === k) || null;
}

function NewComplaintModal({
  orgs: initialOrgs, researchEnabled, onClose, onCreated, initial, importMode, importNotes,
  aiEnabled, fromEmailId,
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
  // Filled in by the AI from the complaint itself.
  const [filled, setFilled] = useState(false);
  const [fillNotes, setFillNotes] = useState(null);
  const [reading, setReading] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState('');

  async function fillFrom(src) {
    setReading(true);
    setError(null);
    try {
      const p = await api.complaints.parseImport(src);
      const org = matchOrg(orgs, p.org_name);
      setForm((f) => ({
        ...f,
        ...Object.fromEntries(Object.entries(toInitial(p)).filter(([k, v]) => k !== '_notes' && v !== '')),
        organisation_id: org ? org.id : '',
        org_name: org ? org.name : p.org_name || f.org_name,
        org_type: org ? org.type : p.org_type || f.org_type,
      }));
      setFilled(true);
      setFillNotes(
        [org ? `Matched to “${org.name}”, already saved.` : p.org_name ? `“${p.org_name}” isn’t saved yet. Research it below so the deadlines follow their procedure.` : '',
          p.confidence ? `Confidence: ${p.confidence}.` : '', p.notes || ''].filter(Boolean).join(' '),
      );
      setPasting(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setReading(false);
    }
  }
  useEffect(() => {
    if (fromEmailId) fillFrom({ emailId: fromEmailId });
  }, [fromEmailId]);

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
          ? `Linked to “${org.name}”, already saved. Its procedure will set the deadlines.`
          : `Found and saved “${org.name}”${org.procedure_ref ? ` (${org.procedure_ref})` : ''}: ` +
            `acknowledge ${org.ack_days ?? '?'} · Stage 1 ${org.stage1_response_days ?? '?'} · ` +
            `Stage 2 ${org.stage2_response_days ?? '?'} working days` +
            (org.unconfirmed?.length ? `. Not confirmed: ${org.unconfirmed.join(', ')}` : '') +
            '. This is AI research: check it against their procedure on the Organisations page ' +
            'before relying on the dates. If you have their procedure document, upload it there instead.',
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
        stage_started_on: form.stage !== 'stage_1' ? form.stage_started_on || null : null,
        // Brought in from before (rather than made today) when it's past Stage 1
        // or already has dates from them.
        imported: Boolean(importMode) ||
          (filled && (form.stage !== 'stage_1' || Boolean(form.acknowledged_on || form.responded_on))),
      });
      onCreated(created);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={importMode ? 'Review imported complaint' : 'Log a complaint'} onClose={onClose}>
      {aiEnabled && !importMode && (
        <div className="card" style={{ padding: 14, marginBottom: 14 }}>
          <div style={{ fontWeight: 600 }}>Fill this in from the complaint itself</div>
          <div className="muted" style={{ fontSize: 13, margin: '4px 0 10px' }}>
            Upload your complaint email or letter (PDF, Word or photo), or paste it. The AI fills in
            the form for you to check.
          </div>
          <div className="btn-row">
            <label className="btn-navy btn-sm" style={{ cursor: 'pointer', margin: 0 }}>
              {reading ? 'Reading…' : '📄 Upload the email or letter'}
              <input type="file" style={{ display: 'none' }} disabled={reading}
                accept=".pdf,.doc,.docx,.txt,.eml,image/*"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) fillFrom({ file: f }); }} />
            </label>
            <button type="button" className="btn btn-sm" onClick={() => setPasting((v) => !v)} disabled={reading}>
              Paste it instead
            </button>
          </div>
          {pasting && (
            <div style={{ marginTop: 10 }}>
              <textarea rows={6} value={pasteText} onChange={(e) => setPasteText(e.target.value)}
                placeholder="Paste the complaint email or letter here…" style={{ width: '100%' }} />
              <button type="button" className="btn-primary btn-sm" style={{ marginTop: 6 }}
                disabled={reading || pasteText.trim().length < 20}
                onClick={() => fillFrom({ text: pasteText })}>
                {reading ? 'Reading…' : 'Fill in the form'}
              </button>
            </div>
          )}
          {filled && (
            <div className="inline-note" style={{ marginTop: 10 }}>
              <strong>Filled in from the complaint.</strong> Check the organisation, the date it was
              made and any dates from them before saving. {fillNotes}
            </div>
          )}
        </div>
      )}
      {importMode && (
        <div className="inline-note" style={{ marginBottom: 14 }}>
          The AI worked these out from what you pasted. <strong>check the date raised, stage and
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
          {form.organisation_id && !note && (
            <div className="inline-note full" style={{ marginBottom: 12 }}>
              ✓ Linked to a saved organisation, so its procedure sets the deadlines.
            </div>
          )}
          {!form.organisation_id && (
            <div className="muted full" style={{ fontSize: 12, marginBottom: 12 }}>
              Not linked to a saved organisation, so general timescales for this type apply. Pick
              one above, or research it, so the deadlines follow their own procedure.
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
          {(importMode || filled) && (
            <>
              <label className="field">
                <span className="lbl">Current stage</span>
                <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>
                  <option value="stage_1">Stage 1</option>
                  <option value="stage_2">Stage 2</option>
                  <option value="ombudsman">Ombudsman</option>
                </select>
              </label>
              {form.stage !== 'stage_1' && (
                <label className="field">
                  <span className="lbl">Stage 2 requested on</span>
                  <input type="date" value={form.stage_started_on || ''}
                    onChange={(e) => setForm({ ...form, stage_started_on: e.target.value })} />
                </label>
              )}
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
      {data && data.count === 0 && <div className="empty">No overdue complaints, so nothing to chase. 🎉</div>}
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

// The next step, as the complaint page gives it: the AI's while its review
// is up to date, otherwise the one the dates give (for each organisation,
// named, when there is more than one), never an out-of-date one.
function nextStepOf(c) {
  const ai = c.ai_review_current && (c.ai_review?.headline || c.ai_review?.recommended_action);
  if (ai) return ai;
  const tracks = [c, ...(c.parties || [])].filter((t) => t.nextAction);
  if ((c.parties || []).length) return tracks.map((t) => `${t.org_name}: ${t.nextAction}`).join(' ') || null;
  return c.nextAction || null;
}

export default function Complaints() {
  const [items, setItems] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [researchEnabled, setResearchEnabled] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [filter, setFilter] = useState('open');
  const [search, setSearch] = useState('');
  const [copiedAccount, setCopiedAccount] = useState(null);
  const [tidyKey, setTidyKey] = useState(0);
  const [showNew, setShowNew] = useState(false);
  // An email from the general inbox being turned into a new complaint.
  const [newFromEmail, setNewFromEmail] = useState(null);
  const [showOverdue, setShowOverdue] = useState(false);
  const [err, setErr] = useState(null);
  const [unfiled, setUnfiled] = useState([]);
  const navigate = useNavigate();

  const loadUnfiled = () =>
    api.complaints.unfiledEmails().then(setUnfiled).catch(() => setUnfiled([]));

  async function fileEmail(emailId, complaintId) {
    if (!complaintId) return;
    try {
      await api.complaints.fileEmail(emailId, complaintId);
      await Promise.all([loadUnfiled(), load()]);
    } catch (e) {
      setErr(e.message);
    }
  }
  async function dismissEmail(emailId) {
    if (!confirm('Remove this email? Only do this if it isn’t about any complaint.')) return;
    try {
      await api.complaints.dismissEmail(emailId);
      await loadUnfiled();
    } catch (e) {
      setErr(e.message);
    }
  }

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
    loadUnfiled();
  }, []);

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

  // Any organisation on a complaint needing chasing counts (a complaint can be
  // with more than one: the debt collector and the supplier).
  const overdue = items.filter((c) => c.any_needs_chasing ?? c.needs_chasing);
  // What needs a person: an email says it's resolved, emails waiting to be
  // checked, needs chasing, or created by the system and not yet checked.
  const attention = items.filter((c) => c.state === 'open' &&
    (c.resolution_suggested || c.new_emails > 0 || (c.any_needs_chasing ?? c.needs_chasing) || c.needs_check));
  function copyAccount(a) {
    navigator.clipboard?.writeText(a).catch(() => {});
    setCopiedAccount(a);
    setTimeout(() => setCopiedAccount((x) => (x === a ? null : x)), 1500);
  }
  const open = items.filter((c) => c.state === 'open');
  const byFilter =
    filter === 'attention' ? attention :
    filter === 'looks_resolved' ? items.filter((c) => c.state === 'open' && c.resolution_suggested) :
    filter === 'overdue' ? overdue :
    filter === 'open' ? open :
    filter === 'resolved' ? items.filter((c) => c.state === 'resolved') :
    filter === 'check' ? items.filter((c) => c.needs_check) :
    items;
  // Search across everything a complaint is known by: subject, organisation,
  // property, our reference and theirs. Searching looks in every state, so an
  // old resolved one is found without changing the filter.
  // An account number matches however it is spaced or punctuated.
  const q = search.trim().toLowerCase();
  const qk = q.replace(/[^a-z0-9]/g, '');
  const shown = !q ? byFilter : items.filter((c) =>
    [c.subject, c.org_name, c.property, c.ref_code, c.reference, c.our_reference, c.category,
      ...(c.parties || []).flatMap((p) => [p.org_name, p.reference])]
      .some((v) => String(v || '').toLowerCase().includes(q)) ||
    (qk.length >= 4 && (c.account_numbers || []).some((a) => String(a).toLowerCase().replace(/[^a-z0-9]/g, '').includes(qk))));

  return (
    <>
      <EmailAutomation onChanged={() => { load(); loadUnfiled(); setTidyKey((k) => k + 1); }} />
      <RecheckAll onChanged={load} />
      <BouncedEmails refreshKey={tidyKey} />
      <TidyUp refreshKey={tidyKey} onChanged={load} />

      {unfiled.length > 0 && (
        <div className="card" style={{ marginBottom: 20, borderTop: '3px solid var(--warn)' }}>
          <div className="card-head">
            <h2>Emails to file <span className="badge amber">{unfiled.length}</span></h2>
          </div>
          <div className="card-body">
            <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
              The system couldn’t tell for certain which complaint these belong to. Pick one and
              it’s filed and recorded as normal.
            </p>
            {unfiled.map((em) => (
              <div key={em.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border, #e5e7eb)' }}>
                <strong>{em.subject || '(no subject)'}</strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  {em.sender_name || em.sender_email} · {formatDate(londonDay(em.received_at))}
                </div>
                {em.analysis?.summary && <div style={{ fontSize: 13, marginTop: 4 }}>{em.analysis.summary}</div>}
                <div className="btn-row" style={{ marginTop: 8 }}>
                  <select defaultValue={em.analysis?.complaint_id || ''} id={`file-${em.id}`} style={{ maxWidth: 420 }}>
                    <option value="">Choose the complaint…</option>
                    {open.map((c) => (
                      <option key={c.id} value={c.id}>{(c.org_names || [c.org_name]).join(' + ')}: {c.subject}</option>
                    ))}
                  </select>
                  <button className="btn-primary btn-sm"
                    onClick={() => fileEmail(em.id, document.getElementById(`file-${em.id}`).value)}>
                    File it
                  </button>
                  {aiEnabled && (
                    <button className="btn btn-sm" onClick={() => setNewFromEmail(em.id)}>
                      It’s a new complaint: start it
                    </button>
                  )}
                  <button className="btn-ghost btn-sm" onClick={() => dismissEmail(em.id)}>Not about a complaint</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="stat-row">
        <div className="stat accent">
          <div className="label">Open complaints</div>
          <div className="value">{open.length}</div>
        </div>
        <div className={`stat ${overdue.length ? 'alert' : ''}`}>
          <div className="label">Need chasing</div>
          <div className="value">{overdue.length}</div>
        </div>
        <div className="stat">
          <div className="label">Total logged</div>
          <div className="value">{items.length}</div>
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by account number, organisation, property, subject or reference…"
          aria-label="Search complaints"
          style={{ maxWidth: 460 }}
        />
        {q && <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>{shown.length} found, across every state</span>}
      </div>

      <div className="toolbar flex-between">
        <div className="btn-row">
          {['attention', 'open', 'looks_resolved', 'overdue', 'check', 'resolved', 'all'].map((f) => (
            (f === 'check' && !items.some((c) => c.needs_check)) ||
            (f === 'looks_resolved' && !items.some((c) => c.state === 'open' && c.resolution_suggested)) ? null :
            <button
              key={f}
              className={filter === f ? 'btn-primary btn-sm' : 'btn-sm'}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {{
                attention: `Needs attention (${attention.length})`,
                open: 'Open',
                looks_resolved: `Looks resolved (${items.filter((c) => c.state === 'open' && c.resolution_suggested).length})`,
                overdue: 'Need chasing', check: `To check (${items.filter((c) => c.needs_check).length})`, resolved: 'Resolved', all: 'All',
              }[f]}
            </button>
          ))}
        </div>
        <div className="btn-row">
          {aiEnabled && overdue.length > 0 && (
            <button className="btn-navy btn-sm" onClick={() => setShowOverdue(true)}>
              ✨ Draft overdue chasers
            </button>
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
                <th>Account number</th>
                <th>Organisation</th>
                <th>Stage</th>
                <th>Next deadline</th>
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
                  // Selecting text (an account number to copy) isn't a click to open.
                  onClick={() => { if (!window.getSelection()?.toString()) navigate(`/complaints/${c.id}`); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/complaints/${c.id}`);
                    }
                  }}
                >
                  <td>
                    <strong>{c.subject}</strong>
                    {c.needs_check && <span className="badge amber" style={{ marginLeft: 6 }}>To check</span>}
                    {c.state === 'open' && c.resolution_suggested && <span className="badge ok" style={{ marginLeft: 6 }}>Looks resolved: confirm</span>}
                    {c.new_emails > 0 && <span className="badge amber" style={{ marginLeft: 6 }}>{c.new_emails} new email{c.new_emails === 1 ? '' : 's'} to check</span>}
                    {c.state === 'open' && nextStepOf(c) && (
                      <div style={{ fontSize: 12, marginTop: 2 }}>
                        <span style={{ fontWeight: 600 }}>Next:</span> {nextStepOf(c)}
                      </div>
                    )}
                    {c.property && <div className="muted" style={{ fontSize: 12 }}>{c.property}</div>}
                  </td>
                  {/* The account number: the key to every complaint, shown to
                      copy without opening it. */}
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {(() => { const k = accountOrReference(c); return k.values.length ? k.values.map((a) => (
                      <div key={a} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontWeight: 700, fontSize: 14, userSelect: 'all' }}>{a}</span>
                        {k.isReference && <span className="muted" style={{ fontSize: 11 }}>their ref</span>}
                        <button type="button" className="btn-ghost btn-sm" style={{ padding: '0 4px', fontSize: 12 }}
                          aria-label={`Copy account number ${a}`}
                          onClick={(e) => { e.stopPropagation(); copyAccount(a); }}
                          onKeyDown={(e) => e.stopPropagation()}>
                          {copiedAccount === a ? '✓' : 'Copy'}
                        </button>
                      </div>
                    )) : <span className="muted">—</span>; })()}
                  </td>
                  {/* One line per organisation when it is with more than one. */}
                  <td className="muted">
                    {[c, ...(c.parties || [])].map((t) => <div key={t.id}>{t.org_name}</div>)}
                  </td>
                  <td>
                    {[c, ...(c.parties || [])].map((t) => (
                      <div key={t.id}><span className="badge navy">{STAGE_LABEL[t.stage] || t.stage}</span></div>
                    ))}
                  </td>
                  <td className="due">
                    {[c, ...(c.parties || [])].map((t) => (
                      <div key={t.id} className={t.needs_chasing ? 'overdue' : ''}>
                        {t.status === 'ack_overdue' || t.status === 'awaiting_ack'
                          ? <>{formatDate(t.ack_due)}<div className="muted" style={{ fontSize: 11 }}>acknowledgement</div></>
                          : formatDate(t.response_due)}
                      </div>
                    ))}
                  </td>
                  <td>
                    {[c, ...(c.parties || [])].map((t) => <div key={t.id}><StatusBadge c={t} /></div>)}
                  </td>
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
          aiEnabled={aiEnabled}
          onClose={() => setShowNew(false)}
          onCreated={(c) => {
            setShowNew(false);
            navigate(`/complaints/${c.id}`);
          }}
        />
      )}

      {newFromEmail && (
        <NewComplaintModal
          orgs={orgs}
          researchEnabled={researchEnabled}
          aiEnabled={aiEnabled}
          fromEmailId={newFromEmail}
          onClose={() => setNewFromEmail(null)}
          onCreated={async (c) => {
            // The email the complaint was started from is filed on it.
            const emailId = newFromEmail;
            setNewFromEmail(null);
            try {
              await api.complaints.fileEmail(emailId, c.id);
            } catch {
              /* it stays in "Emails to file" and can be filed from there */
            }
            navigate(`/complaints/${c.id}`);
          }}
        />
      )}

      {showOverdue && <OverdueDraftsModal onClose={() => setShowOverdue(false)} />}
    </>
  );
}
