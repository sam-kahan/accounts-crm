import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { previewCommission, describePart, ceilingFor } from '../commission';
import Modal from '../components/Modal.jsx';
import BulkLogModal from '../components/BulkLogModal.jsx';
import { useWindowFileDrop, FileDropPrompt } from '../components/FileDrop.jsx';
import MonthSelect from '../components/MonthSelect.jsx';
import OutstandingMonths from '../components/OutstandingMonths.jsx';

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

// "Commission is only on part of this invoice." Some contractors pass materials
// on at cost, or pay a permit on our behalf, and only mark up the rest. Typing
// the resulting commission in by hand would work once and then lose the reason:
// the figure would be flagged as an override, the month end couldn't be
// explained, and amending anything would re-cost it from the whole invoice.
// Stating the PART keeps the arithmetic — and the reason — on the invoice.
function CommissionPartFields({ value, note, onChange, onNote, contractor, amounts }) {
  const [on, setOn] = useState(value !== '' && value !== null && value !== undefined);
  const ceiling = ceilingFor(contractor, amounts);
  const measure = contractor?.commission_on === 'gross' ? 'invoice total' : 'net';

  return (
    <div style={{ margin: '-4px 0 14px' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            if (!e.target.checked) {
              onChange('');
              onNote('');
            }
          }}
        />
        Commission is only on part of this invoice
      </label>
      {on && (
        <div className="form-grid" style={{ marginTop: 8 }}>
          <label className="field">
            <span className="lbl">Part carrying commission (£)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={ceiling ? String(ceiling) : ''}
            />
            <span className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Their rate is applied to this instead of the {measure}
              {ceiling ? ` of ${formatMoney(ceiling)}` : ''}.
            </span>
          </label>
          <label className="field">
            <span className="lbl">Why part only</span>
            <input
              value={note}
              onChange={(e) => onNote(e.target.value)}
              placeholder="e.g. materials passed on at cost"
            />
          </label>
        </div>
      )}
    </div>
  );
}


// Ask the server which office an address belongs to, the same way the save path
// will — including the contractor's usual office, which is what catches an
// address that can't be placed. Debounced, because it runs while the address is
// being typed.
function useDetectedRegion(property, contractorId) {
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
        .region(address, contractorId)
        .then((d) => live && setDetected(d))
        .catch(() => live && setDetected(null));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [property, contractorId]);
  return detected;
}

// Ask the server whether this invoice is already on file, while it is still
// being typed. The unique index would refuse a duplicate on save anyway, but
// only after the whole form has been filled in and the document re-attached —
// and it can't see a duplicate that has no number on it at all.
//
// Debounced like the region lookup, and quiet until there is something worth
// asking about: a contractor, and either their invoice number or a date with
// some money against it. Returns [found, setFound] so the upload path can seed
// the answer it already got back with the extracted fields.
function useDuplicates({
  contractorId,
  invoiceNumber,
  invoiceDate,
  netAmount,
  vatAmount,
  totalAmount,
  excludeId,
}) {
  const [found, setFound] = useState(null);
  const number = (invoiceNumber || '').trim();
  const stated = [netAmount, vatAmount, totalAmount].some(
    (v) => v !== '' && v !== null && v !== undefined,
  );
  const ask = Boolean(contractorId) && Boolean(number || (invoiceDate && stated));

  useEffect(() => {
    if (!ask) {
      setFound(null);
      return undefined;
    }
    let live = true;
    const t = setTimeout(() => {
      api.contractorInvoices
        .duplicates({
          contractor_id: contractorId,
          invoice_number: number,
          invoice_date: invoiceDate,
          net_amount: netAmount,
          vat_amount: vatAmount,
          total_amount: totalAmount,
          exclude_id: excludeId,
        })
        .then((d) => live && setFound(d))
        // A failed check must never stop anyone logging an invoice — the index
        // is still there, so the worst case is the old behaviour.
        .catch(() => live && setFound(null));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [ask, contractorId, number, invoiceDate, netAmount, vatAmount, totalAmount, excludeId]);

  return [found, setFound];
}

// One line describing an invoice already on file, so the warning can be judged
// without leaving the form.
function describeLogged(inv, { number = true } = {}) {
  return [
    inv.ref || null,
    number ? (inv.invoice_number ? `no. ${inv.invoice_number}` : 'no number') : null,
    formatDate(inv.invoice_date),
    formatMoney(inv.total_amount),
    inv.property,
    inv.commission_invoice_number
      ? `on ${inv.commission_invoice_number}`
      : COMMISSION_STATUS_LABEL[inv.status] || null,
  ]
    .filter(Boolean)
    .join(' · ');
}

// What the check found. An exact number match is going to be refused on save,
// so it says so plainly; anything else is a prompt to look, never a block —
// a contractor really can bill the same amount on the same day twice.
function DuplicateNote({ found, verb = 'Logging it again' }) {
  const exact = found?.exact || null;
  const similar = found?.similar || [];
  if (!exact && !similar.length) return null;

  return (
    <div className="inline-note warn" style={{ marginBottom: 14 }}>
      {exact ? (
        <>
          <strong>Already logged.</strong> Invoice{' '}
          <strong>{exact.invoice_number}</strong> is on file for this contractor —{' '}
          {describeLogged(exact, { number: false })}. {verb} would claim its commission twice, so
          this can’t be saved. If it really is a different invoice, give it its own number.
        </>
      ) : (
        <>
          <strong>This looks like one already logged.</strong> Check before saving:
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {similar.slice(0, 4).map((s) => (
              <li key={s.invoice.id}>
                {describeLogged(s.invoice)}
                {s.reason === 'number' ? ' — the same number, punctuated differently' : ''}
                {s.reason === 'details' ? ' — the same day and the same amount' : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
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
  // A file dropped on the page, already chosen — it is read as soon as the
  // form opens, so a drop is the whole action rather than the start of one.
  // More than one file goes to the batch screen instead; this form is for one
  // invoice, with room for all of it.
  initialFile,
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
    commissionable_amount: '',
    commissionable_note: '',
    paid_from: 'client',
    region: '',
    notes: '',
  });
  const [file, setFile] = useState(initialFile || null);
  // Kept in a ref so the window-drop listener below has something stable to
  // call: re-registering it mid-drag would lose count of the dragenters and
  // make the prompt flicker.
  const takeFileRef = useRef(null);
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
  const detectedRegion = useDetectedRegion(form.property, form.contractor_id);
  // Whether this invoice is already on file, asked as it is typed.
  const [duplicates, setDuplicates] = useDuplicates({
    contractorId: form.contractor_id,
    invoiceNumber: form.invoice_number,
    invoiceDate: form.invoice_date,
    netAmount: form.net_amount,
    vatAmount: form.vat_amount,
    totalAmount: form.total_amount,
  });

  const computed = useMemo(
    () =>
      previewCommission(contractor, {
        net: form.net_amount,
        vat: form.vat_amount,
        total: form.total_amount,
        commissionable: form.commissionable_amount,
      }),
    [
      contractor,
      form.net_amount,
      form.vat_amount,
      form.total_amount,
      form.commissionable_amount,
    ],
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
      // The read already checked — show it now rather than 400ms later.
      if (d.duplicates) setDuplicates(d.duplicates);
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
  takeFileRef.current = takeFile;

  // A drop anywhere on this dialog, not only on the dashed box: the box is a
  // small thing to aim at, and the form is often scrolled past it.
  const dragging = useWindowFileDrop(
    useCallback((files) => takeFileRef.current?.(files[0] || null), []),
    true,
  );

  // A file dropped on the page arrives already chosen, so read it straight
  // away. Mount-only: the form is remounted for each file in a batch, so this
  // runs once per invoice.
  useEffect(() => {
    if (initialFile) readFile(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          commissionable_amount: num(form.commissionable_amount),
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
      {dragging && (
        <FileDropPrompt
          overDialog
          title={file ? 'Drop to read a different file' : 'Drop the invoice'}
          hint="PDF, Word, photo or text."
        />
      )}
      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}
      <form onSubmit={save}>
        <div
          className={`dropzone ${dragging ? 'over' : ''} ${file ? 'filled' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              fileInput.current?.click();
            }
          }}
          style={{ marginBottom: 14 }}
        >
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.docx,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv"
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
              <div>Drop the invoice anywhere on this window, or click to choose</div>
              <div className="dz-hint">
                PDF, Word, photo or text
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
        <DuplicateNote found={duplicates} />
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

        <CommissionPartFields
          value={form.commissionable_amount}
          note={form.commissionable_note}
          onChange={(v) => set('commissionable_amount', v)}
          onNote={(v) => set('commissionable_note', v)}
          contractor={contractor}
          amounts={{ net: form.net_amount, vat: form.vat_amount, total: form.total_amount }}
        />

        <div className={`calc-box ${overridden ? 'overridden' : ''}`}>
          <div>
            <div className="calc-label">
              {overridden ? 'Commission (edited by hand)' : 'Commission to reclaim'}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {contractor ? contractor.deal_summary : 'Choose a contractor to apply their rate'}
              {describePart(form.commissionable_amount, form.commissionable_note, contractor, {
                net: form.net_amount,
                vat: form.vat_amount,
                total: form.total_amount,
              })}
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
          <button className="btn-primary" disabled={busy || reading || !!duplicates?.exact}>
            {busy ? 'Saving…' : duplicates?.exact ? 'Already logged' : 'Save invoice'}
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
    commissionable_amount: invoice.commissionable_amount ?? '',
    commissionable_note: invoice.commissionable_note || '',
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
  const detectedRegion = useDetectedRegion(form.property, invoice.contractor_id);
  // The same check the log form runs — a correction can renumber an invoice
  // onto one already on file, which the index would refuse. The invoice being
  // amended is excluded, or it would always find itself.
  const [duplicates] = useDuplicates({
    contractorId: invoice.contractor_id,
    invoiceNumber: form.invoice_number,
    invoiceDate: form.invoice_date,
    netAmount: form.net_amount,
    vatAmount: form.vat_amount,
    totalAmount: form.total_amount,
    excludeId: invoice.id,
  });

  // The deal as it stood when this invoice was logged, not the contractor's
  // deal today — the same snapshot the server recomputes from.
  const computed = useMemo(
    () =>
      previewCommission(invoice, {
        net: form.net_amount,
        vat: form.vat_amount,
        total: form.total_amount,
        commissionable: form.commissionable_amount,
      }),
    [
      invoice,
      form.net_amount,
      form.vat_amount,
      form.total_amount,
      form.commissionable_amount,
    ],
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
        // Explicitly null when the box is cleared: the commission goes back to
        // being costed on the whole invoice, which "omitted" could not say.
        commissionable_amount: form.commissionable_amount === '' ? null : num(form.commissionable_amount),
        commissionable_note: form.commissionable_note || null,
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
    <Modal title={`Amend ${invoice.ref || invoice.invoice_number || 'invoice'}`} onClose={onClose}>
      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}
      <form onSubmit={save}>
        <div className="inline-note" style={{ marginBottom: 14 }}>
          {invoice.ref ? <><span className="ref-code">{invoice.ref}</span> · </> : null}
          From <strong>{invoice.contractor_name}</strong>, logged at{' '}
          {invoice.commission_type === 'fixed'
            ? `${formatMoney(invoice.commission_fixed)} a job`
            : `${Number(invoice.commission_rate)}%`}
          {invoice.has_document ? ' · the uploaded document stays as it is' : ''}.
        </div>
        <DuplicateNote found={duplicates} verb="Renumbering this one onto it" />

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

        <CommissionPartFields
          value={form.commissionable_amount}
          note={form.commissionable_note}
          onChange={(v) => set('commissionable_amount', v)}
          onNote={(v) => set('commissionable_note', v)}
          contractor={invoice}
          amounts={{ net: form.net_amount, vat: form.vat_amount, total: form.total_amount }}
        />

        <div className={`calc-box ${overridden ? 'overridden' : ''}`}>
          <div>
            <div className="calc-label">
              {overridden ? 'Commission (edited by hand)' : 'Commission to reclaim'}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Worked out from the rate this invoice was logged under
              {describePart(form.commissionable_amount, form.commissionable_note, invoice, {
                net: form.net_amount,
                vat: form.vat_amount,
                total: form.total_amount,
              })}
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
          <button className="btn-primary" disabled={busy || !!duplicates?.exact}>
            {busy ? 'Saving…' : duplicates?.exact ? 'Number already used' : 'Save changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// The columns of the logged-invoice table, in order: what each is called, the
// sort key the API knows it by, and which way round it should read the first
// time it is clicked. A date or an amount is asked about biggest-first; a name
// or a reference reads A-Z.
const COLUMNS = [
  { key: 'ref', label: 'Ref' },
  { key: 'invoice_date', label: 'Date', desc: true },
  { key: 'contractor', label: 'Contractor' },
  { key: 'region', label: 'Office' },
  { key: 'invoice_number', label: 'Invoice' },
  { key: 'property', label: 'Property / works' },
  { key: 'total_amount', label: 'Invoice total', desc: true, num: true },
  { key: 'commission_amount', label: 'Commission', desc: true, num: true },
  { key: 'status', label: 'Status' },
];

// A column heading you can sort by. The arrow only appears on the column doing
// the sorting — a row of arrows on every heading reads as decoration and stops
// saying anything.
function SortHeader({ col, sort, dir, onSort }) {
  const active = sort === col.key;
  return (
    <th
      className={col.num ? 'num' : undefined}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className={`th-sort ${active ? 'active' : ''}`}
        onClick={() => onSort(col)}
        title={`Sort by ${col.label.toLowerCase()}`}
      >
        {col.label}
        <span aria-hidden="true" className="th-arrow">{active ? (dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );
}

// What to say once a batch is finished. A single invoice keeps the wording it
// always had; a batch says how many landed, and still offers the month link
// when any of them were dated outside the one on screen.
function noticeForSaved(saved, month) {
  const strays = saved.filter((s) => s.mismatch);
  if (saved.length === 1) {
    const only = saved[0];
    // The reference is the thing worth quoting afterwards, so the confirmation
    // says it rather than just "saved".
    const logged = only.ref ? `Logged as ${only.ref}.` : 'Logged.';
    if (!only.mismatch) return { text: logged };
    return {
      month: only.month,
      text: `${logged} It's dated ${formatDate(only.date)}, so it's in ${monthLabel(only.month)}, not the month you're viewing.`,
    };
  }
  if (!saved.length) return null;
  if (strays.length) {
    return {
      month: strays[0].month,
      text: `Logged ${saved.length} invoices — ${strays.length} of them dated outside ${monthLabel(month)}, so they aren't in this list.`,
    };
  }
  return { text: `Logged ${saved.length} invoices.` };
}

export default function ContractorInvoices() {
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [contractors, setContractors] = useState([]);
  const [aiEnabled, setAiEnabled] = useState(false);
  // The one invoice being logged: { file } (or a file of null, from the
  // button). A batch goes to `bulk` below instead.
  const [logging, setLogging] = useState(null);
  // A batch: every file read at once, checked side by side, submitted in one
  // go. One file is still the full form — it has room for the whole invoice.
  const [bulk, setBulk] = useState(null);
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState(null);
  // Earlier months whose commission was never raised.
  const [outstanding, setOutstanding] = useState(null);
  const [err, setErr] = useState(null);

  const contractorId = params.get('contractor_id') || '';
  const status = params.get('status') || '';
  const month = params.get('month') || monthOf();
  const region = params.get('region') || '';
  const search = params.get('search') || '';
  // Sorting lives in the URL like every other filter, so a sorted list is a
  // link somebody can send.
  const sort = params.get('sort') || '';
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc';

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
      sort,
      dir,
      from: `${month}-01`,
      to: `${month}-${String(last).padStart(2, '0')}`,
    };
  }, [contractorId, status, region, search, month, sort, dir]);

  const load = () => {
    setErr(null);
    // Quietly, and on its own: a failed missed-month check must not stop the
    // list being read.
    api.contractorInvoices
      .outstanding({ before: month })
      .then(setOutstanding)
      .catch(() => setOutstanding(null));
    return api.contractorInvoices
      .list(filters)
      .then(setRows)
      .catch((e) => setErr(e.message));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractorId, status, region, search, month, sort, dir]);

  // Click a heading to sort by it; click the one already sorting to turn it
  // round.
  function sortBy(col) {
    const next = new URLSearchParams(params);
    const flipped = sort === col.key && dir === (col.desc ? 'desc' : 'asc');
    next.set('sort', col.key);
    next.set('dir', flipped ? (col.desc ? 'asc' : 'desc') : col.desc ? 'desc' : 'asc');
    setParams(next, { replace: true });
  }

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

  // One file opens the full form; more than one goes to the batch screen,
  // where they are all read at once and checked together.
  const startLogging = useCallback((files) => {
    setNotice(null);
    if (files.length > 1) {
      setBulk(files);
      return;
    }
    setLogging({ file: files[0] || null });
  }, []);

  // What to say after invoices were logged — one, or a batch of them.
  const savedNotice = (list) => setNotice(noticeForSaved(list, month));
  const savedEntry = (inv) => {
    const savedMonth = (inv?.invoice_date || '').slice(0, 7);
    return {
      ref: inv?.ref || null,
      date: inv?.invoice_date,
      month: savedMonth,
      mismatch: !!savedMonth && savedMonth !== month,
    };
  };

  // Files dropped on the page open the log form — or the batch screen. While
  // either is open it takes the drop instead, so the page stands down.
  const dragging = useWindowFileDrop(startLogging, !logging && !editing && !bulk);

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
          {notice.month && (
            <button className="linkish" onClick={() => { setParam('month', notice.month); setNotice(null); }}>
              Show {monthLabel(notice.month)}
            </button>
          )}
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
          <button className="btn" onClick={() => setBulk([])}>Upload a batch</button>
          <button className="btn-primary" onClick={() => startLogging([])}>+ Log invoice</button>
        </div>
      </div>

      <div className="muted drop-hint">
        Or drag invoices straight onto this page — drop a whole batch and they're read together,
        then checked and logged in one go.
      </div>

      <OutstandingMonths data={outstanding} month={month} onPick={(m) => setParam('month', m)} />

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
            Nothing logged for {monthLabel(month)}. Drop contractor invoices anywhere on this page
            — several at once is fine — and the details are read off them.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <SortHeader key={col.key} col={col} sort={sort} dir={dir} onSort={sortBy} />
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <span className="ref-code">{r.ref || '—'}</span>
                  </td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{formatDate(r.invoice_date)}</td>
                  <td>{r.contractor_name}</td>
                  <td className="muted" style={{ whiteSpace: 'nowrap' }}>{r.region_label || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
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
                    {/* What the figure IS depends on the contractor's VAT
                        status, so the unusual half says so: a contractor who
                        isn't VAT registered only ever collected this much, so
                        it is VAT-inclusive and we invoice it netted down. */}
                    {r.commission_vat_inclusive && (
                      <div
                        className="muted"
                        style={{ fontSize: 12 }}
                        title="They aren't VAT registered, so this is all they collected. We invoice it netted down — VAT comes out of it, not on top."
                      >
                        incl. VAT
                      </div>
                    )}
                    {r.commissionable_amount !== null && r.commissionable_amount !== undefined && (
                      <div
                        className="muted"
                        style={{ fontSize: 12 }}
                        title={r.commissionable_note || 'Commission is on part of this invoice only'}
                      >
                        on {formatMoney(r.commissionable_amount)} of it
                      </div>
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
                <td colSpan={6}>{monthLabel(month)} total</td>
                <td className="num">{formatMoney(totals.invoiced)}</td>
                <td className="num">{formatMoney(totals.commission)}</td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {dragging && (
        <FileDropPrompt
          title="Drop to log the invoice"
          hint={`PDF, Word, photo or text. Drop several and they're all read at once, then checked together${
            aiEnabled ? '' : ' (automatic reading is off — the details are typed in)'
          }.`}
        />
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        <strong>Commission</strong> is what the contractor collected inside their invoice. Where
        they are VAT registered that is the net, and VAT is added on top when we invoice it back
        (£9.00 → £10.80). Where they are not, it is all they took, so it is treated as
        VAT-inclusive and invoiced netted down (£9.00 → £7.50 + £1.50), and they pay back exactly
        what they collected.
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

      {bulk && (
        <BulkLogModal
          files={bulk}
          contractors={contractors}
          aiEnabled={aiEnabled}
          month={month}
          onClose={() => {
            setBulk(null);
            load();
          }}
          onLogged={(saved) => {
            savedNotice(saved.map(savedEntry));
            load();
          }}
        />
      )}

      {logging && (
        <LogInvoiceModal
          // A fresh form per file in the batch — the previous one's fields
          // must not carry over into the next invoice.
          key={logging.file?.name || 'blank'}
          contractors={contractors}
          aiEnabled={aiEnabled}
          preselect={contractorId}
          month={month}
          initialFile={logging.file}
          onContractorAdded={(c) => setContractors((list) => [...list, c])}
          onClose={() => setLogging(null)}
          onSaved={(saved) => {
            setLogging(null);
            // An invoice dated outside the month on screen (often because the
            // date was read off the document) would otherwise just not appear.
            savedNotice([savedEntry(saved)]);
            load();
          }}
        />
      )}
    </>
  );
}
