import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, formatDate, ORG_TYPE_LABEL, plural } from '../api';
import Modal from '../components/Modal.jsx';
import { FIGURES, blank, mergeProfile, fillStandard, researchGaps } from '../procedureMerge.js';

const EMPTY = {
  name: '', type: 'council', location: '', complaints_email: '', complaints_url: '',
  phone: '', ombudsman_name: '', ombudsman_url: '', ombudsman_referral_months: '',
  stage1_response_days: '', stage2_response_days: '', ack_days: '',
  procedure_ref: '', stage1_clock: '', ombudsman_after_weeks: '', referral_from: '',
  procedure_summary: '', legal_basis: '', sources: [], unconfirmed: [], procedure_evidence: {}, procedure_sources: {},
  research_status: 'none', notes: '', verified: false,
};

function num(v) { return v === '' || v == null ? null : Number(v); }

function OrgModal({ initial, researchEnabled, onClose, onSaved }) {
  const [form, setForm] = useState(() =>
    initial
      ? {
          ...EMPTY,
          ...Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v ?? EMPTY[k] ?? ''])),
          procedure_evidence: initial.procedure_evidence || {},
          procedure_sources: initial.procedure_sources || {},
          unconfirmed: initial.unconfirmed || [],
          sources: initial.sources || [],
          verified: Boolean(initial.verified_at),
        }
      : EMPTY,
  );
  const [defaults, setDefaults] = useState(null);
  // The ombudsman register, for choosing the scheme this organisation belongs to.
  const [schemes, setSchemes] = useState([]);
  useEffect(() => { api.ombudsmen.list().then(setSchemes).catch(() => setSchemes([])); }, []);
  const [docs, setDocs] = useState([]);
  const [pendingDoc, setPendingDoc] = useState(null); // file read, stored on save
  const createdId = useRef(null); // set once a new organisation has been saved
  const [busy, setBusy] = useState(false);
  const [researching, setResearching] = useState(false);
  const [reading, setReading] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  // A figure changed by hand is one someone entered: its quote no longer applies.
  // Changing anything that sets a date un-ticks "checked against their
  // procedure": what was checked is no longer what is saved.
  const set = (k, v) => setForm((f) => {
    const procedural = FIGURES.includes(k) || k === 'type' || k === 'procedure_ref' || k === 'ombudsman_id';
    if (procedural && String(f[k] ?? '') !== String(v ?? '')) f = { ...f, verified: false };
    if (!FIGURES.includes(k)) return { ...f, [k]: v };
    const evidence = { ...(f.procedure_evidence || {}) };
    delete evidence[k];
    const sources = { ...(f.procedure_sources || {}) };
    if (blank(v)) delete sources[k]; else sources[k] = 'entered';
    return { ...f, [k]: v, procedure_evidence: evidence, procedure_sources: sources,
      unconfirmed: (f.unconfirmed || []).filter((u) => u !== k || blank(v)) };
  });

  useEffect(() => {
    api.organisations.defaults(form.type).then((d) => {
      setDefaults(d);
      setForm((f) => fillStandard(f, d)); // figures nobody gives show the standard, marked as such
    }).catch(() => setDefaults(null));
  }, [form.type]);
  useEffect(() => {
    if (initial?.id) api.organisations.documents(initial.id).then(setDocs).catch(() => setDocs([]));
  }, [initial?.id]);

  async function research() {
    if (!form.name.trim()) { setError('Enter the organisation name first.'); return; }
    if ((form.researched_at || Object.values(form.procedure_sources || {}).includes('research')) &&
        !confirm('Their website has already been researched. Research it again? (Only worth it if their procedure has changed: it uses AI credits.)')) return;
    setResearching(true);
    setError(null);
    setInfo(null);
    try {
      const p = await api.organisations.research({
        name: form.name, type: form.type, location: form.location,
      });
      const { form: merged, took } = mergeProfile(form, p, 'research');
      const next = fillStandard({ ...merged, researched_at: new Date().toISOString() }, defaults);
      setForm(next);
      setInfo(took.length
        ? `Researched from their website: ${took.length} figure${took.length === 1 ? '' : 's'} filled in, each with the source it came from. Anything from their own procedure document was kept.`
        : 'Researched their website: nothing new to add. Their own procedure document and anything typed in were kept.');
    } catch (err) {
      setError(err.message);
    } finally {
      setResearching(false);
    }
  }

  async function readDocument(file) {
    if (!file) return;
    setReading(true);
    setError(null);
    setInfo(null);
    try {
      const p = await api.organisations.readProcedure(file, { name: form.name, type: form.type });
      let { form: next, took } = mergeProfile(form, p, 'document');
      setPendingDoc(file);
      const kept = FIGURES.filter((k) => !took.includes(k) && !blank(next[k]));
      // Whatever neither the document nor earlier research gave is researched
      // now, so a gap is filled with their real figure where one is published.
      let researched = [];
      // Research only if it has never been done: research already done is
      // kept (and paid for once), never repeated.
      const researchedBefore = Boolean(form.researched_at) || Object.values(form.procedure_sources || {}).includes('research');
      const gaps = researchGaps(next, defaults);
      if (!researchedBefore && gaps.length && researchEnabled && next.name.trim()) {
        setForm(next);
        setInfo(`Read from “${file.name}”. Researching the ${gaps.length} timescale${gaps.length === 1 ? '' : 's'} it doesn't give…`);
        try {
          const r = await api.organisations.research({ name: next.name, type: next.type, location: next.location });
          ({ form: next, took: researched } = mergeProfile(next, r, 'research'));
        } catch {
          /* research failing leaves the standard figures to apply */
        }
      }
      next = fillStandard(next, defaults);
      setForm(next);
      const parts = [
        `${took.length} from “${file.name}”`,
        kept.length ? `${kept.length} kept from before (the document doesn't mention ${kept.length === 1 ? 'it' : 'them'})` : null,
        researched.length ? `${researched.length} found by research` : null,
        next.unconfirmed.length ? `${next.unconfirmed.length} not published by them, so the standard for this kind of organisation is used` : null,
      ].filter(Boolean);
      setInfo(`Figures: ${parts.join('; ')}. Each says where it came from. The document is kept on this organisation when you save.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setReading(false);
    }
  }

  async function removeDoc(doc) {
    if (!confirm(`Remove “${doc.filename}” from this organisation?`)) return;
    try {
      await api.organisations.removeDocument(doc.id);
      setDocs((d) => d.filter((x) => x.id !== doc.id));
    } catch (err) {
      setError(err.message);
    }
  }

  async function save(e) {
    e.preventDefault();
    // Saving unchecked figures is allowed, but never by accident: until the box
    // is ticked every complaint against them says "not checked yet".
    if (!form.verified && !confirm(
      'You haven’t ticked “I have checked these figures against their published procedure”.\n\n' +
        'Save anyway? Complaints against them will show the procedure as not checked until someone does.',
    )) return;
    setBusy(true);
    setError(null);
    const payload = {
      name: form.name,
      type: form.type,
      location: form.location || null,
      complaints_email: form.complaints_email || null,
      complaints_url: form.complaints_url || null,
      phone: form.phone || null,
      ombudsman_name: form.ombudsman_name || null,
      ombudsman_url: form.ombudsman_url || null,
      // '' = the usual scheme for its type (the register); otherwise the one chosen.
      ombudsman_id: form.ombudsman_id || null,
      ombudsman_referral_months: num(form.ombudsman_referral_months),
      stage1_response_days: num(form.stage1_response_days),
      stage2_response_days: num(form.stage2_response_days),
      ack_days: num(form.ack_days),
      procedure_ref: form.procedure_ref || null,
      stage1_clock: form.stage1_clock || null,
      ombudsman_after_weeks: num(form.ombudsman_after_weeks),
      referral_from: form.referral_from || null,
      procedure_summary: form.procedure_summary || null,
      legal_basis: form.legal_basis || null,
      sources: form.sources || [],
      unconfirmed: form.unconfirmed || [],
      procedure_evidence: form.procedure_evidence || {},
      procedure_sources: form.procedure_sources || {},
      researched_now: Boolean(form.researched_now),
      // Typing a timescale of THEIRS in by hand makes it a procedure someone
      // entered; the standard figures the form shows for blanks never do.
      research_status:
        form.research_status === 'none' && (
          !blank(form.procedure_ref) ||
          ['ack_days', 'stage1_response_days', 'stage2_response_days', 'ombudsman_after_weeks', 'ombudsman_referral_months']
            .some((k) => !blank(form[k]) && form.procedure_sources?.[k] !== 'standard'))
          ? 'manual'
          : form.research_status,
      verified: Boolean(form.verified),
      notes: form.notes || null,
    };
    // Once created, later saves update it: if the document upload after the
    // create fails, pressing Save again must not make a second organisation.
    const id = initial?.id || createdId.current;
    try {
      const saved = id
        ? await api.organisations.update(id, payload)
        : await api.organisations.create(payload);
      createdId.current = saved.id;
      if (pendingDoc) {
        try {
          await api.organisations.uploadDocuments(saved.id, [pendingDoc]);
        } catch (err) {
          setError(`Saved, but their procedure document couldn’t be uploaded (${err.message}). Press Save to try the upload again.`);
          setBusy(false);
          return;
        }
      }
      onSaved(saved);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  // A figure's source: the quote it came from, or a plain statement that the
  // general default applies because their procedure doesn't say.
  const FROM = {
    document: 'From their procedure document', research: 'Researched from their website', entered: 'Typed in',
    standard: 'Standard for this kind of organisation (they don’t publish their own)',
  };
  const Evidence = ({ k, dflt }) => {
    const q = form.procedure_evidence?.[k];
    const src = form.procedure_sources?.[k];
    const empty = blank(form[k]);
    if (!empty && (q || src)) {
      return (
        <span className="muted" style={{ fontSize: 12 }}>
          {src ? <>{FROM[src] || src}{q ? ': ' : '.'}</> : null}
          {q ? <span style={{ fontStyle: 'italic' }}>“{q}”</span> : null}
        </span>
      );
    }
    if (empty && dflt !== undefined && dflt !== null) {
      return <span className="muted" style={{ fontSize: 12 }}>Not published by them, so the standard for this kind of organisation applies: {String(dflt)}.</span>;
    }
    return null;
  };

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

        <div className="card" style={{ margin: '4px 0 16px', padding: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Their complaints procedure</div>
          <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
            Best: upload their own procedure document. Otherwise research their website. Either
            way, the figures are filled in for you to check.
          </div>
          <div className="btn-row">
            <label className="btn-navy btn-sm" style={{ cursor: researchEnabled ? 'pointer' : 'not-allowed', margin: 0, opacity: researchEnabled ? 1 : 0.6 }}>
              {reading ? 'Reading…' : '📄 Upload their procedure document'}
              <input type="file" className="file-input-hidden" disabled={reading || !researchEnabled}
                accept=".pdf,.doc,.docx,.txt,image/*"
                onChange={(e) => { readDocument(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            <button type="button" className="btn btn-sm" onClick={() => setPasting((v) => !v)} disabled={reading || !researchEnabled}>
              📋 Paste the procedure text
            </button>
            <button type="button" className="btn btn-sm" onClick={research}
              disabled={researching || !researchEnabled}
              title={researchEnabled ? '' : 'Set ANTHROPIC_API_KEY on the server to enable'}>
              {researching ? 'Researching…' : '🔎 Research their website'}
            </button>
          </div>
          {pasting && (
            <div style={{ marginTop: 10 }}>
              <textarea rows={8} value={pasteText} onChange={(e) => setPasteText(e.target.value)}
                placeholder="Paste their complaints procedure here (from their website or a letter)…" style={{ width: '100%' }} />
              <button type="button" className="btn-primary btn-sm" style={{ marginTop: 6 }}
                disabled={reading || pasteText.trim().length < 50}
                onClick={() => {
                  // Read like an uploaded document, and kept on file as one.
                  const file = new File([pasteText], `${(form.name || 'procedure').replace(/[^\w ]+/g, '').trim() || 'procedure'} complaints procedure (pasted).txt`, { type: 'text/plain' });
                  readDocument(file).then(() => setPasting(false));
                }}>
                {reading ? 'Reading…' : 'Read it'}
              </button>
            </div>
          )}
          {(() => {
            const researchedAt = form.researched_at;
            const standard = FIGURES.filter((k) => form.procedure_sources?.[k] === 'standard' || blank(form[k]));
            if (researching || reading) return null;
            if (researchedAt || Object.values(form.procedure_sources || {}).includes('research')) {
              return (
                <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                  ✓ Their website was researched{researchedAt ? ` on ${formatDate(researchedAt)}` : ''}.
                  {standard.length ? ` ${standard.length} figure${standard.length === 1 ? ' isn’t' : 's aren’t'} published by them, so the standard is used. No need to research again.` : ''}
                </div>
              );
            }
            if (!researchEnabled || !standard.length) return null;
            return (
              <div className="inline-note" style={{ marginTop: 10, fontSize: 13 }}>
                Not researched yet: {standard.length} figure{standard.length === 1 ? ' is' : 's are'} the standard for this kind of
                organisation. <strong>Research their website</strong> once to find their own; it won’t change anything from their
                procedure document or typed in.
              </div>
            );
          })()}
          {!researchEnabled && (
            <div className="inline-note warn" style={{ marginTop: 10 }}>
              Reading and research need <code>ANTHROPIC_API_KEY</code> on the server. You can still
              type the procedure in by hand.
            </div>
          )}
          {info && <div className="inline-note" style={{ marginTop: 10 }}>{info}</div>}
          {docs.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 13 }}>
              <div className="lbl">Documents on file</div>
              {docs.map((d) => (
                <div key={d.id} className="flex-between" style={{ gap: 8 }}>
                  <a href={api.organisations.documentUrl(d.id)} target="_blank" rel="noreferrer">{d.filename}</a>
                  <span className="muted">{formatDate(d.uploaded_at)}
                    <button type="button" className="btn-ghost btn-sm" onClick={() => removeDoc(d)}
                      aria-label={`Remove ${d.filename}`}>✕</button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="form-grid">
          <label className="field full"><span className="lbl">Procedure name / version</span>
            <input value={form.procedure_ref || ''} onChange={(e) => set('procedure_ref', e.target.value)}
              placeholder="e.g. PRO39 V7 (Jul 2025)" />
            <Evidence k="procedure_ref" /></label>
          <label className="field"><span className="lbl">Complaints email</span>
            <input value={form.complaints_email || ''} onChange={(e) => set('complaints_email', e.target.value)} />
            <Evidence k="complaints_email" /></label>
          <label className="field"><span className="lbl">Complaints page URL</span>
            <input value={form.complaints_url || ''} onChange={(e) => set('complaints_url', e.target.value)} /></label>

          <label className="field"><span className="lbl">Acknowledge within (working days)</span>
            <input type="number" min="0" value={form.ack_days ?? ''} onChange={(e) => set('ack_days', e.target.value)} />
            <Evidence k="ack_days" dflt={defaults?.ackDays} /></label>
          <label className="field"><span className="lbl">Stage 1 outcome within (working days)</span>
            <input type="number" min="0" value={form.stage1_response_days ?? ''} onChange={(e) => set('stage1_response_days', e.target.value)} />
            <Evidence k="stage1_response_days" dflt={defaults?.stage1Days} /></label>
          <label className="field"><span className="lbl">Stage 1 counted from</span>
            <select value={form.stage1_clock || ''} onChange={(e) => set('stage1_clock', e.target.value)}>
              <option value="">Not stated (use when they receive it)</option>
              <option value="receipt">When they receive it</option>
              <option value="acknowledgement">When they acknowledge it</option>
            </select>
            <Evidence k="stage1_clock" /></label>
          <label className="field"><span className="lbl">Stage 2 response within (working days)</span>
            <input type="number" min="0" value={form.stage2_response_days ?? ''} onChange={(e) => set('stage2_response_days', e.target.value)} />
            <Evidence k="stage2_response_days" dflt={defaults?.stage2Days} /></label>

          {(() => {
            const usual = schemes.find((x) => (x.usual_for || []).includes(form.type));
            const chosen = schemes.find((x) => x.id === form.ombudsman_id) || (!form.ombudsman_id ? usual : null);
            return (
              <label className="field full"><span className="lbl">Ombudsman scheme it belongs to</span>
                <select value={form.ombudsman_id || ''} onChange={(e) => set('ombudsman_id', e.target.value)}>
                  <option value="">{usual ? `The usual one for this type: ${usual.name}` : 'None chosen (no scheme is known for this type)'}</option>
                  {schemes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <span className="muted" style={{ fontSize: 12 }}>
                  {chosen
                    ? <>When a complaint can go to {chosen.name} and the time limit come from its record on the{' '}
                      <Link to="/ombudsmen">Ombudsmen</Link> page{chosen.verified_at ? ' (checked)' : ' (not checked yet: nothing is shown as ready to refer until it is)'}.
                      The ombudsman figures below are not used while a scheme applies.</>
                    : form.type === 'managing_agent'
                      ? 'A managing agent belongs to The Property Ombudsman OR the Property Redress Scheme: choose the one it says it belongs to. Until then no complaint against it is shown as ready to refer.'
                      : 'With no scheme, no complaint against it is shown as ready to refer.'}
                </span>
              </label>
            );
          })()}
          <label className="field"><span className="lbl">Ombudsman / redress scheme (as their procedure names it)</span>
            <input value={form.ombudsman_name || ''} onChange={(e) => set('ombudsman_name', e.target.value)} />
            <Evidence k="ombudsman_name" dflt={defaults?.ombudsman} /></label>
          <label className="field"><span className="lbl">Ombudsman website</span>
            <input value={form.ombudsman_url || ''} onChange={(e) => set('ombudsman_url', e.target.value)}
              placeholder="Filled in automatically" />
            {!form.ombudsman_url && (
              <span className="muted" style={{ fontSize: 12 }}>
                Leave blank. It’s filled in when you save for recognised schemes (The Property
                Ombudsman, Property Redress Scheme, Housing Ombudsman, LGSCO, Energy Ombudsman,
                CCW and others).
              </span>
            )}</label>
          <label className="field"><span className="lbl">Can refer after (weeks, if unresolved)</span>
            <input type="number" min="0" value={form.ombudsman_after_weeks ?? ''} onChange={(e) => set('ombudsman_after_weeks', e.target.value)} />
            <Evidence k="ombudsman_after_weeks" dflt={defaults?.ombudsmanAfterWeeks ?? undefined} /></label>
          <label className="field"><span className="lbl">Must refer within (months)</span>
            <input type="number" min="0" value={form.ombudsman_referral_months ?? ''} onChange={(e) => set('ombudsman_referral_months', e.target.value)} />
            <Evidence k="ombudsman_referral_months" dflt={defaults?.referralMonths} /></label>
          <label className="field full"><span className="lbl">…counted from</span>
            <select value={form.referral_from || ''} onChange={(e) => set('referral_from', e.target.value)}>
              <option value="">Default for this type{defaults?.referralFrom === 'final_response' ? ' (their final response)' : ' (when the complaint was made)'}</option>
              <option value="raised">When the complaint was made</option>
              <option value="final_response">Their final response</option>
            </select>
            <Evidence k="referral_from" /></label>

          <label className="field full"><span className="lbl">How their procedure works</span>
            <textarea rows={4} value={form.procedure_summary || ''} onChange={(e) => set('procedure_summary', e.target.value)} /></label>
          <label className="field full"><span className="lbl">Ombudsman and the law</span>
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

        <label className="inline-note" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={Boolean(form.verified)} onChange={(e) => set('verified', e.target.checked)}
            style={{ marginTop: 3 }} />
          <span>
            <strong>I have checked these figures against their published procedure.</strong>
            <span style={{ display: 'block', fontSize: 12 }}>
              Complaints show the procedure as checked, with your name and the date. Leave it
              unticked if you haven’t, and they will say it still needs checking.
            </span>
          </span>
        </label>

        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ProcedureBadge({ o }) {
  if (o.verified_at) return <span className="badge ok" title={`Checked by ${o.verified_by || '—'}`}>Checked</span>;
  if (o.research_status === 'document') return <span className="badge amber">From document, not checked</span>;
  if (o.research_status === 'researched') return <span className="badge amber">Researched, not checked</span>;
  if (o.research_status === 'manual') return <span className="badge amber">Entered, not checked</span>;
  return <span className="badge grey">Not set</span>;
}

export default function Organisations() {
  const [orgs, setOrgs] = useState(null);
  const [editing, setEditing] = useState(null); // org object or 'new'
  const [researchEnabled, setResearchEnabled] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  // ?open=<id> (from the search box) opens that organisation straight away.
  const [params, setParams] = useSearchParams();
  const load = () => {
    setErr(null);
    return api.organisations
      .list()
      .then(setOrgs)
      .catch((e) => setErr(e.message));
  };
  // Whenever ?open= changes, not only on the first load: a result picked in
  // the search box while already on this page changed the address and
  // opened nothing.
  const want = params.get('open');
  useEffect(() => {
    if (!want || !orgs) return;
    const hit = orgs.find((o) => o.id === want);
    if (hit) { setEditing(hit); setParams({}, { replace: true }); }
  }, [want, orgs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    load();
    api.organisations
      .researchConfig()
      .then((c) => setResearchEnabled(c.enabled))
      .catch(() => setResearchEnabled(false));
  }, []);

  async function remove(o) {
    const n = Number(o.complaint_count || 0);
    if (!confirm(
      `Delete ${o.name}?` +
        (n ? `\n\n${plural(n, 'complaint')} against it will fall back to the standard timescales (each date that moves is noted on its timeline).` : ''),
    )) return;
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
        <div className="muted">Bodies you complain to, and the procedure each one must follow.</div>
        <button className="btn-primary" onClick={() => setEditing('new')}>+ Add organisation</button>
      </div>

      {err && (
        <div className="inline-note warn" style={{ marginBottom: 12 }}>
          {err} <button className="linkish" onClick={load}>Retry</button>
        </div>
      )}
      {note && <div className="inline-note" style={{ marginBottom: 12 }}>{note}</div>}

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
              <tr><th>Name</th><th>Type</th><th>Procedure</th><th>Complaints</th><th></th></tr>
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
                    {o.email_bounced && (
                      <span className="badge red" style={{ marginLeft: 6 }}
                        title="An email to their complaints address bounced. Check the address; see Bounced emails on the Complaints page.">
                        Email bounced
                      </span>
                    )}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {[o.procedure_ref, o.location].filter(Boolean).join(' · ') || o.ombudsman_name || ''}
                    </div>
                  </td>
                  <td><span className="badge navy">{ORG_TYPE_LABEL[o.type] || o.type}</span></td>
                  <td><ProcedureBadge o={o} /></td>
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
          onSaved={(saved) => {
            setEditing(null);
            setNote(
              saved?.recalculated
                ? `Saved. ${saved.recalculated === 1 ? '1 open complaint against them has' : `${saved.recalculated} open complaints against them have`} new dates from this procedure: each change is noted on its timeline, and its AI review is being refreshed.`
                : 'Saved.',
            );
            load();
          }}
        />
      )}
    </>
  );
}
