import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  formatDate,
  formatMoney,
  todayISO,
  monthOf,
  monthLabel,
  COMMISSION_STATUS_LABEL,
  REGIONS,
  REGION_LABEL,
} from '../api';
import Modal from '../components/Modal.jsx';
import MonthSelect from '../components/MonthSelect.jsx';

const STATUS_BADGE = {
  pending: 'amber',
  invoiced: 'navy',
  paid: 'ok',
  waived: 'grey',
};

function num(v) {
  return v === '' || v === null || v === undefined ? undefined : Number(v);
}

// The date a new invoice starts on: today when you're looking at this month,
// otherwise the last day of the month you have open — so an invoice logged
// while reviewing September lands in September, not in today's month where you
// wouldn't see it.
function defaultDateFor(month) {
  const today = todayISO();
  if (month === today.slice(0, 7)) return today;
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return today;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

// A preview of what the server will charge, shown live as the amounts are
// typed. The server recomputes from the contractor's agreement when it saves —
// this figure is only sent if the user deliberately overrides it.
function previewCommission(contractor, { net, vat, total }) {
  if (!contractor) return 0;
  const netN = Number(net || 0);
  const vatN = Number(vat || 0);
  const totalN = Number(total || 0) || netN + vatN;
  const base = Math.max(0, contractor.commission_on === 'gross' ? totalN : netN);
  const rate = Number(contractor.commission_rate || 0);
  const basis = contractor.commission_basis || 'markup';

  if (contractor.commission_type === 'fixed') {
    const fixed = Number(contractor.commission_fixed || 0);
    return basis === 'on_top' ? fixed : Math.min(fixed, totalN || fixed);
  }
  // markup: the rate was added to the contractor's own price, so the
  // commission inside the invoice is net x rate / (100 + rate) — £9 on a £99
  // invoice at 10%, not £9.90.
  if (basis === 'markup') {
    return rate > 0 ? Math.round((base * rate * 100) / (100 + rate)) / 100 : 0;
  }
  const raw = Math.round(base * rate) / 100;
  return basis === 'inclusive' ? Math.min(raw, totalN || raw) : raw;
}


// Ask the server which office an address belongs to, the same way the save path
// will. Debounced, because it runs while the address is being typed.
function useDetectedRegion(property) {
  const [detected, setDetected] = useState(null);
  useEffect(() => {
    const address = (property || '').trim();
    if (!address) {
      setDetected(null);
      return undefined;
    }
    let live = true;
    const t = setTimeout(() => {
      api.contractorInvoices
        .region(address)
        .then((d) => live && setDetected(d))
        .catch(() => live && setDetected(null));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [property]);
  return detected;
}

// The office field, with whatever the address says about it underneath. Shared
// by logging an invoice and amending one, so the two can never explain the
// same address differently.
function RegionField({ value, onChange, detected }) {
  return (
    <label className="field">
      <span className="lbl">Invoiced by</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Work it out from the address</option>
        {REGIONS.map((r) => (
          <option key={r.key} value={r.key}>{r.label}</option>
        ))}
      </select>
      <span className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {value
          ? `${REGION_LABEL[value]} raises the commission invoice for this job.`
          : detected?.region
            ? `${detected.region_label} — ${detected.reason}`
            : detected?.reason || 'Manchester and Liverpool invoice separately.'}
      </span>
    </label>
  );
}

function LogInvoiceModal({
  contractors,
  aiEnabled,
  preselect,
  month,
  onContractorAdded,
  onClose,
  onSaved,
}) {
  const [form, setForm] = useState({
    contractor_id: preselect || '',
    invoice_number: '',
    invoice_date: defaultDateFor(month),
    property: '',
    landlord_ref: '',
    description: '',
    net_amount: '',
    vat_amount: '',
    total_amount: '',
    paid_from: 'client',
    region: '',
    notes: '',
  });
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState(null);
  const [stated, setStated] = useState(null); // commission the invoice itself named
  const [match, setMatch] = useState(null); // which contractor the invoice was traced to
  const [suggestion, setSuggestion] = useState(null); // set up a contractor we don't have
  const [newRate, setNewRate] = useState('10');
  const [adding, setAdding] = useState(false);
  const [commission, setCommission] = useState(''); // '' = use the agreed rate
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileInput = useRef(null);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const contractor = contractors.find((c) => c.id === form.contractor_id) || null;
  // Why the office ended up where it did — read live off the address, so a
  // property typed by hand is explained the same way an uploaded one is.
  const detectedRegion = useDetectedRegion(form.property);

  const computed = useMemo(
    () =>
      previewCommission(contractor, {
        net: form.net_amount,
        vat: form.vat_amount,
        total: form.total_amount,
      }),
    [contractor, form.net_amount, form.vat_amount, form.total_amount],
  );
  const overridden = commission !== '' && Number(commission) !== computed;

  // Hand the file to the server, which reads it and gives back the fields.
  async function readFile(f, contractorId) {
    if (!aiEnabled || !f) return;
    setReading(true);
    setReadNote(null);
    setError(null);
    try {
      const d = await api.contractorInvoices.extract(f, contractorId || form.contractor_id);
      setForm((prev) => ({
        ...prev,
        // Whoever the invoice says it's from, unless one was already chosen.
        contractor_id: prev.contractor_id || d.contractor_id || '',
        invoice_number: d.invoice_number || prev.invoice_number,
        invoice_date: d.invoice_date || prev.invoice_date,
        property: d.property || prev.property,
        description: d.description || prev.description,
        net_amount: d.net_amount ?? prev.net_amount,
        vat_amount: d.vat_amount ?? prev.vat_amount,
        total_amount: d.total_amount ?? prev.total_amount,
        // Only ever filled in, never overwritten: if the user has already said
        // which office this is, the postcode doesn't get to argue.
        region: prev.region || d.region || '',
      }));
      setStated(d.commission_stated ?? null);
      setSuggestion(d.contractor_id ? null : d.contractor_suggestion || null);
      setMatch(
        d.contractor_name
          ? {
              name_on_invoice: d.contractor_name,
              selected_by: d.contractor_selected_by || null,
              mismatch: !!d.contractor_mismatch,
              // The best candidate on file, when there was one.
              candidate: d.contractor_match?.name || null,
              chosen:
                contractors.find((c) => c.id === (d.contractor_id || ''))?.name ||
                d.contractor_match?.name ||
                null,
            }
          : null,
      );
      setReadNote(
        d.caution
          ? `Read from the invoice — check these: ${d.caution}`
          : 'Read from the invoice — check the figures before saving.',
      );
    } catch (e) {
      setReadNote(`Couldn’t read the invoice automatically (${e.message}). Enter the details below.`);
    } finally {
      setReading(false);
    }
  }

  // The invoice tells us who they are, where they are and whether they charge
  // VAT. The commission rate is the one thing it can't — that's the agreement —
  // so it's asked for here and nothing is created until it's confirmed.
  async function createFromInvoice() {
    const rate = Number(newRate);
    if (!Number.isFinite(rate) || rate <= 0) {
      setError('Enter the commission rate agreed with them first.');
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const created = await api.contractors.create({
        name: suggestion.name,
        address: suggestion.address || '',
        email: suggestion.email || '',
        phone: suggestion.phone || '',
        vat_registered: !!suggestion.vat_registered,
        commission_rate: rate,
        commission_type: 'percentage',
        commission_basis: 'markup',
        commission_on: 'net',
        agreement_notes: `Set up from invoice ${form.invoice_number || ''}`.trim(),
      });
      onContractorAdded(created);
      set('contractor_id', created.id);
      setSuggestion(null);
      setMatch({ name: created.name, confident: true, name_on_invoice: suggestion.name });
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  }

  function takeFile(f) {
    setFile(f);
    if (f) readFile(f);
  }

  async function save(e) {
    e.preventDefault();
    if (!form.contractor_id) {
      setError('Choose the contractor first.');
      return;
    }
    // With neither an office nor an address there is nothing to work it out
    // from, and the server would only bounce it back. Otherwise let the server
    // read the address — it says which office it landed on, and why, if it
    // can't tell.
    if (!form.region && !form.property.trim()) {
      setError('Choose which office this job belongs to — Manchester or Liverpool.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await api.contractorInvoices.create(
        {
          ...form,
          net_amount: num(form.net_amount),
          vat_amount: num(form.vat_amount),
          total_amount: num(form.total_amount),
          // Only sent when deliberately overridden — otherwise the server
          // applies the contractor's agreed rate.
          commission_amount: overridden ? Number(commission) : undefined,
          extracted: !!readNote && !readNote.startsWith('Couldn’t'),
        },
        file,
      );
      onSaved(saved);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Log a contractor invoice" onClose={onClose}>
      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}
      <form onSubmit={save}>
        <div
          className={`dropzone ${dragOver ? 'over' : ''} ${file ? 'filled' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              fileInput.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            takeFile(e.dataTransfer.files?.[0] || null);
          }}
          style={{ marginBottom: 14 }}
        >
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv"
            onChange={(e) => takeFile(e.target.files?.[0] || null)}
          />
          {reading ? (
            <div>Reading the invoice…</div>
          ) : file ? (
            <>
              <div className="dz-name">{file.name}</div>
              <div className="dz-hint">Click to choose a different file</div>
            </>
          ) : (
            <>
              <div>Drop the invoice here, or click to choose</div>
              <div className="dz-hint">
                PDF, photo or text
                {aiEnabled ? ' — the details are read off it automatically' : ''}
              </div>
            </>
          )}
        </div>

        <label className="field">
          <span className="lbl">Contractor *</span>
          <select
            required
            value={form.contractor_id}
            onChange={(e) => {
              set('contractor_id', e.target.value);
              setMatch(null);
            }}
          >
            <option value="">Choose…</option>
            {contractors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.trade ? ` — ${c.trade}` : ''} ({c.deal_summary})
              </option>
            ))}
          </select>
        </label>

        {readNote && (
          <div className="inline-note" style={{ marginBottom: 14 }}>{readNote}</div>
        )}
        {detectedRegion && !detectedRegion.region && !form.region && (
          <div className="inline-note warn" style={{ marginBottom: 14 }}>
            Which office is this job — {REGION_LABEL.manchester} or {REGION_LABEL.liverpool}?{' '}
            {detectedRegion.reason} Choose one under <strong>Invoiced by</strong> below.
          </div>
        )}
        {match && (
          <div
            className={`inline-note ${
              match.mismatch || !match.selected_by ? 'warn' : ''
            }`}
            style={{ marginBottom: 14 }}
          >
            {match.mismatch ? (
              <>
                This invoice is from <strong>{match.name_on_invoice}</strong>, but{' '}
                <strong>{match.chosen}</strong> is selected below. Check which is right — the
                commission is worked out from whoever is selected.
              </>
            ) : match.selected_by === 'matched' ? (
              <>
                From <strong>{match.chosen}</strong> - their agreed rate has been applied.
                {match.name_on_invoice !== match.chosen
                  ? ` (the invoice says "${match.name_on_invoice}")`
                  : ''}
              </>
            ) : match.selected_by === 'given' ? (
              <>
                Read from the invoice, logged against <strong>{match.chosen}</strong> - their
                agreed rate has been applied.
              </>
            ) : match.candidate ? (
              <>
                The invoice says "{match.name_on_invoice}". Closest on file is{' '}
                <strong>{match.candidate}</strong>, but not close enough to be sure - pick the
                contractor below.
              </>
            ) : (
              <>No contractor on file matches "{match.name_on_invoice}".</>
            )}
          </div>
        )}

        {suggestion?.name && (
          <div className="calc-box" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 220, flex: 1 }}>
              <div className="calc-label">Set up {suggestion.name}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {[suggestion.address, suggestion.email, suggestion.phone]
                  .filter(Boolean)
                  .join(' · ') || 'Taken from the invoice'}
                <br />
                {suggestion.vat_registered
                  ? 'VAT registered (their invoice charges VAT)'
                  : 'Not VAT registered (no VAT on their invoice)'}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: 12 }}>
                Commission
                <input
                  type="number"
                  step="0.001"
                  min="0"
                  max="100"
                  value={newRate}
                  onChange={(e) => setNewRate(e.target.value)}
                  style={{ width: 80, marginLeft: 6 }}
                  aria-label="Commission rate for the new contractor"
                />
                %
              </label>
              <button
                type="button"
                className="btn-primary btn-sm"
                disabled={adding}
                onClick={createFromInvoice}
              >
                {adding ? 'Adding…' : 'Add contractor'}
              </button>
            </div>
          </div>
        )}
        {!aiEnabled && (
          <div className="inline-note warn" style={{ marginBottom: 14 }}>
            Automatic reading is off. Add <code>ANTHROPIC_API_KEY</code> to the server .env to
            have invoice details filled in for you — the file still uploads and saves either way.
          </div>
        )}

        <div className="form-grid">
          <label className="field">
            <span className="lbl">Their invoice number</span>
            <input
              value={form.invoice_number}
              onChange={(e) => set('invoice_number', e.target.value)}
              placeholder="Stops the same invoice being logged twice"
            />
          </label>
          <label className="field">
            <span className="lbl">Invoice date *</span>
            <input
              type="date"
              required
              value={form.invoice_date}
              onChange={(e) => set('invoice_date', e.target.value)}
            />
            <span className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Goes into {monthLabel((form.invoice_date || '').slice(0, 7)) || '—'}
              {(form.invoice_date || '').slice(0, 7) !== month
                ? ` — not the ${monthLabel(month)} you're viewing`
                : ''}
            </span>
          </label>
          <label className="field">
            <span className="lbl">Property</span>
            <input value={form.property} onChange={(e) => set('property', e.target.value)} />
          </label>
          <RegionField
            value={form.region}
            onChange={(v) => set('region', v)}
            detected={detectedRegion}
          />
          <label className="field">
            <span className="lbl">Landlord / statement ref</span>
            <input value={form.landlord_ref} onChange={(e) => set('landlord_ref', e.target.value)} />
          </label>
          <label className="field full">
            <span className="lbl">Works</span>
            <input
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="e.g. Tap repair"
            />
          </label>
          <label className="field">
            <span className="lbl">Net (£)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.net_amount}
              onChange={(e) => set('net_amount', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="lbl">VAT (£)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.vat_amount}
              onChange={(e) => set('vat_amount', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="lbl">Invoice total (£)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.total_amount}
              onChange={(e) => set('total_amount', e.target.value)}
              placeholder="Leave blank to use net + VAT"
            />
          </label>
          <label className="field">
            <span className="lbl">Paid from</span>
            <select value={form.paid_from} onChange={(e) => set('paid_from', e.target.value)}>
              <option value="client">Client account</option>
              <option value="business">Business account</option>
            </select>
          </label>
        </div>

        <div className={`calc-box ${overridden ? 'overridden' : ''}`}>
          <div>
            <div className="calc-label">
              {overridden ? 'Commission (edited by hand)' : 'Commission to reclaim'}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {contractor ? contractor.deal_summary : 'Choose a contractor to apply their rate'}
              {overridden ? ` · agreed rate gives ${formatMoney(computed)}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="calc-value">{formatMoney(overridden ? commission : computed)}</div>
            <input
              type="number"
              step="0.01"
              min="0"
              value={commission}
              onChange={(e) => setCommission(e.target.value)}
              placeholder="Override"
              style={{ width: 110 }}
              aria-label="Override the commission amount"
            />
          </div>
        </div>

        {stated !== null && Math.abs(Number(stated) - computed) > 0.005 && (
          <div className="inline-note warn" style={{ marginBottom: 14 }}>
            The invoice itself names a commission of <strong>{formatMoney(stated)}</strong>, which
            doesn’t match the {formatMoney(computed)} their agreed rate gives. Check which is right
            before saving.
          </div>
        )}

        <label className="field">
          <span className="lbl">Notes</span>
          <textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>

        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || reading}>
            {busy ? 'Saving…' : 'Save invoice'}
          </button>
        </div>
      </form>
    </Modal>
  );
}


// Amend a logged invoice. Only the details are editable — the contractor is
// not, because the commission was costed under THEIR agreement and the row
// carries that agreement as a snapshot; logging it against somebody else is a
// different invoice, so it is deleted and logged again. The document stays as
// uploaded: it is the evidence, and a correction to what was read off it must
// not quietly replace it.
function EditInvoiceModal({ invoice, onClose, onSaved }) {
  const [form, setForm] = useState({
    invoice_number: invoice.invoice_number || '',
    invoice_date: invoice.invoice_date || '',
    property: invoice.property || '',
    region: invoice.region || '',
    landlord_ref: invoice.landlord_ref || '',
    description: invoice.description || '',
    net_amount: invoice.net_amount ?? '',
    vat_amount: invoice.vat_amount ?? '',
    total_amount: invoice.total_amount ?? '',
    paid_from: invoice.paid_from || 'client',
    paid_on: invoice.paid_on || '',
    notes: invoice.notes || '',
  });
  // A hand-typed figure is kept as an override; blank means "use the agreed
  // rate", which is what the server recomputes.
  const [commission, setCommission] = useState(
    invoice.commission_override ? String(invoice.commission_amount) : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const detectedRegion = useDetectedRegion(form.property);

  // The deal as it stood when this invoice was logged, not the contractor's
  // deal today — the same snapshot the server recomputes from.
  const computed = useMemo(
    () =>
      previewCommission(invoice, {
        net: form.net_amount,
        vat: form.vat_amount,
        total: form.total_amount,
      }),
    [invoice, form.net_amount, form.vat_amount, form.total_amount],
  );
  const overridden = commission !== '' && Number(commission) !== computed;

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await api.contractorInvoices.update(invoice.id, {
        ...form,
        net_amount: num(form.net_amount),
        vat_amount: num(form.vat_amount),
        total_amount: num(form.total_amount),
        paid_on: form.paid_on || null,
        // Blank means "whatever the office works out to"; the server keeps the
        // one already stored rather than re-reading a corrected address behind
        // anyone's back.
        region: form.region || undefined,
        commission_amount: overridden ? Number(commission) : undefined,
      });
      onSaved(saved);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Amend ${invoice.invoice_number || 'invoice'}`} onClose={onClose}>
      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}
      <form onSubmit={save}>
        <div className="inline-note" style={{ marginBottom: 14 }}>
          From <strong>{invoice.contractor_name}</strong>, logged at{' '}
          {invoice.commission_type === 'fixed'
            ? `${formatMoney(invoice.commission_fixed)} a job`
            : `${Number(invoice.commission_rate)}%`}
          {invoice.has_document ? ' · the uploaded document stays as it is' : ''}.
        </div>

        <div className="form-grid">
          <label className="field">
            <span className="lbl">Their invoice number</span>
            <input
              value={form.invoice_number}
              onChange={(e) => set('invoice_number', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="lbl">Invoice date *</span>
            <input
              type="date"
              required
              value={form.invoice_date}
              onChange={(e) => set('invoice_date', e.target.value)}
            />
            <span className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Goes into {monthLabel((form.invoice_date || '').slice(0, 7)) || '—'}
            </span>
          </label>
          <label className="field">
            <span className="lbl">Property</span>
            <input value={form.property} onChange={(e) => set('property', e.target.value)} />
          </label>
          <RegionField
            value={form.region}
            onChange={(v) => set('region', v)}
            detected={detectedRegion}
          />
          <label className="field">
            <span className="lbl">Landlord / statement ref</span>
            <input value={form.landlord_ref} onChange={(e) => set('landlord_ref', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Paid from</span>
            <select value={form.paid_from} onChange={(e) => set('paid_from', e.target.value)}>
              <option value="client">Client account</option>
              <option value="business">Business account</option>
            </select>
          </label>
          <label className="field full">
            <span className="lbl">Works</span>
            <input value={form.description} onChange={(e) => set('description', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Net (£)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.net_amount}
              onChange={(e) => set('net_amount', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="lbl">VAT (£)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.vat_amount}
              onChange={(e) => set('vat_amount', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="lbl">Invoice total (£)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.total_amount}
              onChange={(e) => set('total_amount', e.target.value)}
              placeholder="Leave blank to use net + VAT"
            />
          </label>
          <label className="field">
            <span className="lbl">Paid on</span>
            <input
              type="date"
              value={form.paid_on}
              onChange={(e) => set('paid_on', e.target.value)}
            />
          </label>
        </div>

        <div className={`calc-box ${overridden ? 'overridden' : ''}`}>
          <div>
            <div className="calc-label">
              {overridden ? 'Commission (edited by hand)' : 'Commission to reclaim'}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Worked out from the rate this invoice was logged under
              {overridden ? ` · that rate gives ${formatMoney(computed)}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="calc-value">{formatMoney(overridden ? commission : computed)}</div>
            <input
              type="number"
              step="0.01"
              min="0"
              value={commission}
              onChange={(e) => setCommission(e.target.value)}
              placeholder="Override"
              style={{ width: 110 }}
              aria-label="Override the commission amount"
            />
          </div>
        </div>

        <label className="field">
          <span className="lbl">Notes</span>
          <textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>

        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function ContractorInvoices() {
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [contractors, setContractors] = useState([]);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [logging, setLogging] = useState(false);
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState(null);
  const [err, setErr] = useState(null);

  const contractorId = params.get('contractor_id') || '';
  const status = params.get('status') || '';
  const month = params.get('month') || monthOf();
  const region = params.get('region') || '';
  const search = params.get('search') || '';

  const setParam = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const filters = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      contractor_id: contractorId,
      status,
      region,
      search,
      from: `${month}-01`,
      to: `${month}-${String(last).padStart(2, '0')}`,
    };
  }, [contractorId, status, region, search, month]);

  const load = () => {
    setErr(null);
    return api.contractorInvoices
      .list(filters)
      .then(setRows)
      .catch((e) => setErr(e.message));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractorId, status, region, search, month]);

  useEffect(() => {
    api.contractors.list({ active: 'true' }).then(setContractors).catch(() => setContractors([]));
    api.contractorInvoices
      .aiConfig()
      .then((c) => setAiEnabled(c.enabled))
      .catch(() => setAiEnabled(false));
  }, []);

  async function waive(row) {
    const reason = row.waived
      ? null
      : prompt('Why is this commission not being reclaimed?', 'Not chargeable');
    if (!row.waived && reason === null) return;
    try {
      await api.contractorInvoices.waive(row.id, !row.waived, reason);
      await load();
    } catch (e) {
      setErr(e.message);
    }
  }

  async function remove(row) {
    if (!confirm(`Delete the logged invoice ${row.invoice_number || ''}?`)) return;
    try {
      await api.contractorInvoices.remove(row.id);
      await load();
    } catch (e) {
      setErr(e.message);
    }
  }

  const totals = (rows || []).reduce(
    (acc, r) => {
      acc.invoiced += Number(r.total_amount || 0);
      acc.commission += Number(r.commission_amount || 0);
      if (r.status === 'pending') acc.pending += Number(r.commission_amount || 0);
      return acc;
    },
    { invoiced: 0, commission: 0, pending: 0 },
  );

  return (
    <>
      <div className="stat-row">
        <div className="stat accent">
          <div className="label">Commission this month</div>
          <div className="value">{formatMoney(totals.commission)}</div>
        </div>
        <div className="stat">
          <div className="label">Still to invoice</div>
          <div className="value">{formatMoney(totals.pending)}</div>
        </div>
        <div className="stat">
          <div className="label">Paid out to contractors</div>
          <div className="value">{formatMoney(totals.invoiced)}</div>
        </div>
      </div>

      {notice && (
        <div className="inline-note" style={{ marginBottom: 12 }}>
          {notice.text}{' '}
          <button className="linkish" onClick={() => { setParam('month', notice.month); setNotice(null); }}>
            Show {monthLabel(notice.month)}
          </button>
        </div>
      )}

      <div className="toolbar flex-between">
        <div className="btn-row">
          <MonthSelect value={month} onChange={(m) => setParam('month', m)} />
          <select
            value={contractorId}
            onChange={(e) => setParam('contractor_id', e.target.value)}
            aria-label="Contractor"
          >
            <option value="">All contractors</option>
            {contractors.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select
            value={region}
            onChange={(e) => setParam('region', e.target.value)}
            aria-label="Office"
          >
            <option value="">Both offices</option>
            {REGIONS.map((r) => (
              <option key={r.key} value={r.key}>{r.label}</option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => setParam('status', e.target.value)}
            aria-label="Status"
          >
            <option value="">Any status</option>
            <option value="pending">To invoice</option>
            <option value="invoiced">Invoiced</option>
            <option value="paid">Paid</option>
            <option value="waived">Waived</option>
          </select>
          <input
            type="search"
            placeholder="Search…"
            defaultValue={search}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setParam('search', e.currentTarget.value);
            }}
            onBlur={(e) => setParam('search', e.currentTarget.value)}
          />
        </div>
        <div className="btn-row">
          <a
            className="btn"
            href={api.contractorInvoices.exportUrl({
              month,
              contractor_id: contractorId,
              status,
              region,
            })}
          >
            Export CSV
          </a>
          <button className="btn-primary" onClick={() => setLogging(true)}>+ Log invoice</button>
        </div>
      </div>

      {err && (
        <div className="inline-note warn" style={{ marginBottom: 12 }}>
          {err} <button className="linkish" onClick={load}>Retry</button>
        </div>
      )}

      <div className="card">
        {!rows ? (
          err ? (
            <div className="empty">Couldn’t load invoices.</div>
          ) : (
            <div className="spinner">Loading…</div>
          )
        ) : rows.length === 0 ? (
          <div className="empty">
            Nothing logged for {monthLabel(month)}. Upload a contractor invoice to get started.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Contractor</th>
                <th>Office</th>
                <th>Invoice</th>
                <th>Property / works</th>
                <th className="num">Invoice total</th>
                <th className="num">Commission</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{formatDate(r.invoice_date)}</td>
                  <td>{r.contractor_name}</td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{r.region_label || '—'}</td>
                  <td>
                    {r.invoice_number || <span className="muted">—</span>}
                    {r.has_document && (
                      <a
                        href={api.contractorInvoices.documentUrl(r.id)}
                        className="badge navy"
                        style={{ marginLeft: 6 }}
                        title="Download the invoice document"
                      >
                        ↓ file
                      </a>
                    )}
                  </td>
                  <td>
                    {r.property || <span className="muted">—</span>}
                    {r.description && (
                      <div className="muted" style={{ fontSize: 12 }}>{r.description}</div>
                    )}
                  </td>
                  <td className="num">{formatMoney(r.total_amount)}</td>
                  <td className="num">
                    <strong>{formatMoney(r.commission_amount)}</strong>
                    {r.commission_override && (
                      <div className="muted" style={{ fontSize: 12 }}>edited</div>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[r.status] || 'grey'}`}>
                      {COMMISSION_STATUS_LABEL[r.status] || r.status}
                    </span>
                    {r.commission_invoice_number && (
                      <div className="muted" style={{ fontSize: 12 }}>{r.commission_invoice_number}</div>
                    )}
                    {r.waived && r.waived_reason && (
                      <div className="muted" style={{ fontSize: 12 }}>{r.waived_reason}</div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {r.status === 'invoiced' || r.status === 'paid' ? (
                      // On a commission invoice: changing it now would leave
                      // what was billed and what is recorded disagreeing. Void
                      // that invoice and the line comes back here to amend.
                      <span
                        className="muted"
                        style={{ fontSize: 12 }}
                        title={`Void ${r.commission_invoice_number || 'the commission invoice'} to amend this`}
                      >
                        billed
                      </span>
                    ) : (
                      <>
                        <button className="btn-ghost btn-sm" onClick={() => setEditing(r)}>
                          Amend
                        </button>
                        <button className="btn-ghost btn-sm" onClick={() => waive(r)}>
                          {r.waived ? 'Un-waive' : 'Waive'}
                        </button>
                        <button className="btn-danger btn-sm" onClick={() => remove(r)}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={5}>{monthLabel(month)} total</td>
                <td className="num">{formatMoney(totals.invoiced)}</td>
                <td className="num">{formatMoney(totals.commission)}</td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <EditInvoiceModal
          invoice={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            const savedMonth = (saved?.invoice_date || '').slice(0, 7);
            setNotice(
              savedMonth && savedMonth !== month
                ? {
                    month: savedMonth,
                    text: `Saved — but it's now dated ${formatDate(saved.invoice_date)}, so it's in ${monthLabel(savedMonth)}, not the month you're viewing.`,
                  }
                : null,
            );
            load();
          }}
        />
      )}

      {logging && (
        <LogInvoiceModal
          contractors={contractors}
          aiEnabled={aiEnabled}
          preselect={contractorId}
          month={month}
          onContractorAdded={(c) => setContractors((list) => [...list, c])}
          onClose={() => setLogging(false)}
          onSaved={(saved) => {
            setLogging(false);
            // An invoice dated outside the month on screen (often because the
            // date was read off the document) would otherwise just not appear.
            const savedMonth = (saved?.invoice_date || '').slice(0, 7);
            setNotice(
              savedMonth && savedMonth !== month
                ? {
                    month: savedMonth,
                    text: `Saved — but it's dated ${formatDate(saved.invoice_date)}, so it's in ${monthLabel(savedMonth)}, not the month you're viewing.`,
                  }
                : null,
            );
            load();
          }}
        />
      )}
    </>
  );
}
