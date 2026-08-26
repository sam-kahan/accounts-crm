import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatMoney, formatDate, todayISO, REGIONS } from '../api';
import { previewCommission } from '../commission';
import Modal from './Modal.jsx';

// Logging a month's post one invoice at a time means waiting for each document
// to be read before the next one can be started. Here the whole batch is read
// at once — several at a time, in the background — and what came back is
// checked side by side and submitted in one go.
//
// Reading is the slow part (a document goes to the model), so it runs a few
// files deep rather than one at a time; more than a handful in flight just
// queues at the other end and makes the first result slower.
const READERS = 3;

let counter = 0;
const nextId = () => {
  counter += 1;
  return `bulk-${counter}`;
};

// The date a row starts on when the document didn't state one: today when the
// month on screen is this month, otherwise the last day of the month being
// worked, so it lands where it is being looked for.
function defaultDateFor(month) {
  const today = todayISO();
  if (month === today.slice(0, 7)) return today;
  const [y, m] = String(month).split('-').map(Number);
  if (!y || !m) return today;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

function rowFor(file, month) {
  return {
    id: nextId(),
    file,
    // queued -> reading -> ready -> saving -> saved, with error at any point.
    state: 'queued',
    error: null,
    note: null,
    duplicates: null,
    // The name printed on the invoice, and what we could trace it to.
    nameOnInvoice: null,
    readFailed: false,
    mismatch: false,
    regionReason: null,
    saved: null,
    fields: {
      contractor_id: '',
      invoice_number: '',
      invoice_date: defaultDateFor(month),
      property: '',
      description: '',
      net_amount: '',
      vat_amount: '',
      total_amount: '',
      region: '',
    },
  };
}

// What still needs a human before this row can be saved.
//
// `needs` are the empty fields the save would be refused for, collapsed into
// one line — a batch of ten invoices with three notes each is a wall of amber
// nobody reads, and "needs a contractor and an office" says the same thing in
// a line. `notes` are the things worth actual sentences: an invoice already on
// file, or a name that doesn't match the contractor selected.
function problemsFor(row) {
  const none = { needs: [], notes: [], stop: false };
  if (row.state === 'saved' || row.state === 'reading' || row.state === 'queued') return none;
  const f = row.fields;
  const needs = [];
  const notes = [];

  if (!f.contractor_id) needs.push('a contractor');
  else if (row.mismatch && row.nameOnInvoice) {
    notes.push({
      level: 'warn',
      text: `The invoice says “${row.nameOnInvoice}”, which isn't the contractor selected — the rate comes from whoever is selected.`,
    });
  }
  if (row.nameOnInvoice && !f.contractor_id) {
    notes.push({
      level: 'warn',
      text: `No contractor on file matches “${row.nameOnInvoice}”. Set them up on the Contractors page, or pick who this is.`,
    });
  }

  const exact = row.duplicates?.exact;
  if (exact) {
    notes.push({
      level: 'stop',
      text: `Already logged as ${exact.ref || exact.invoice_number} — logging it again would claim its commission twice.`,
    });
  } else if (row.duplicates?.similar?.length) {
    const s = row.duplicates.similar[0];
    notes.push({
      level: 'warn',
      text: `Looks like ${s.invoice.ref || s.invoice.invoice_number || 'one already logged'} (${formatDate(
        s.invoice.invoice_date,
      )}, ${formatMoney(s.invoice.total_amount)}) — worth a look before logging.`,
    });
  }

  if (!f.invoice_date) needs.push('a date');
  if (!f.region && !f.property.trim()) needs.push('an office');
  else if (!f.region && row.regionReason) {
    notes.push({ level: 'warn', text: `${row.regionReason} Check the office below.` });
  }

  const money = [f.net_amount, f.vat_amount, f.total_amount].some((v) => Number(v) > 0);
  if (!money) needs.push('the amounts');

  return { needs, notes, stop: !!exact };
}

// Everything in `needs` and an invoice already on file stop a row being logged;
// the warnings never do.
function blocked(row) {
  const p = problemsFor(row);
  return p.stop || p.needs.length > 0;
}

function listOf(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const STATE_LABEL = {
  queued: 'Waiting',
  reading: 'Reading…',
  saving: 'Logging…',
  saved: 'Logged',
  error: 'Failed',
};

// One invoice in the batch: what was read off it, ready to be corrected.
function BulkRow({ row, contractors, onChange, onRemove, onRetry }) {
  const contractor = contractors.find((c) => c.id === row.fields.contractor_id) || null;
  const { needs, notes } = problemsFor(row);
  const stopped = blocked(row);
  const commission = useMemo(
    () =>
      previewCommission(contractor, {
        net: row.fields.net_amount,
        vat: row.fields.vat_amount,
        total: row.fields.total_amount,
      }),
    [contractor, row.fields.net_amount, row.fields.vat_amount, row.fields.total_amount],
  );

  const set = (k, v) => onChange({ ...row.fields, [k]: v });
  const busy = row.state === 'reading' || row.state === 'saving';
  const done = row.state === 'saved';

  return (
    <div className={`bulk-row ${done ? 'done' : ''} ${row.state === 'error' ? 'failed' : ''}`}>
      <div className="bulk-row-head">
        <div className="bulk-file" title={row.file.name}>
          {row.file.name}
        </div>
        <span
          className={`badge ${
            done ? 'ok' : row.state === 'error' ? 'red' : stopped ? 'amber' : 'grey'
          }`}
        >
          {STATE_LABEL[row.state] || (stopped ? 'Needs you' : 'Ready')}
        </span>
        {done ? (
          <div className="bulk-saved">
            <span className="ref-code">{row.saved?.ref}</span> · {formatMoney(row.saved?.commission_amount)}{' '}
            commission
          </div>
        ) : (
          <>
            <div className="bulk-commission">
              {contractor ? formatMoney(commission) : <span className="muted">—</span>}
            </div>
            <button type="button" className="btn-ghost btn-sm" onClick={onRemove} disabled={busy}>
              Remove
            </button>
          </>
        )}
      </div>

      {row.state === 'error' && (
        <div className="inline-note warn" style={{ margin: '0 0 10px' }}>
          {row.error} Correct it below and log the batch again.
        </div>
      )}

      {!done && row.state !== 'queued' && row.state !== 'reading' && (
        <>
          {needs.length > 0 && (
            <div className="inline-note warn" style={{ margin: '0 0 8px', fontSize: 13 }}>
              Needs {listOf(needs)}.
            </div>
          )}
          {notes.map((p) => (
            <div
              key={p.text}
              className={`inline-note ${p.level === 'stop' ? 'warn' : ''}`}
              style={{ margin: '0 0 8px', fontSize: 13 }}
            >
              {p.text}
            </div>
          ))}

          <div className="bulk-fields">
            <label className="field">
              <span className="lbl">Contractor *</span>
              <select
                value={row.fields.contractor_id}
                onChange={(e) => set('contractor_id', e.target.value)}
              >
                <option value="">Choose…</option>
                {contractors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.deal_summary})
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="lbl">Their invoice no.</span>
              <input
                value={row.fields.invoice_number}
                onChange={(e) => set('invoice_number', e.target.value)}
              />
            </label>
            <label className="field">
              <span className="lbl">Date *</span>
              <input
                type="date"
                value={row.fields.invoice_date}
                onChange={(e) => set('invoice_date', e.target.value)}
              />
            </label>
            <label className="field">
              <span className="lbl">Office</span>
              <select value={row.fields.region} onChange={(e) => set('region', e.target.value)}>
                <option value="">From the address</option>
                {REGIONS.map((r) => (
                  <option key={r.key} value={r.key}>{r.label}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="lbl">Net (£)</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={row.fields.net_amount}
                onChange={(e) => set('net_amount', e.target.value)}
              />
            </label>
            <label className="field">
              <span className="lbl">VAT (£)</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={row.fields.vat_amount}
                onChange={(e) => set('vat_amount', e.target.value)}
              />
            </label>
            <label className="field">
              <span className="lbl">Total (£)</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={row.fields.total_amount}
                onChange={(e) => set('total_amount', e.target.value)}
                placeholder="net + VAT"
              />
            </label>
            <label className="field wide">
              <span className="lbl">Property</span>
              <input value={row.fields.property} onChange={(e) => set('property', e.target.value)} />
            </label>
            <label className="field wide">
              <span className="lbl">Works</span>
              <input
                value={row.fields.description}
                onChange={(e) => set('description', e.target.value)}
              />
            </label>
          </div>

          {row.note && (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {row.note}{' '}
              {row.readFailed && (
                <button className="linkish" onClick={onRetry} type="button">
                  Read it again
                </button>
              )}
            </div>
          )}
        </>
      )}

      {row.state === 'reading' && <div className="muted">Reading the invoice…</div>}
      {row.state === 'queued' && <div className="muted">Waiting to be read…</div>}
    </div>
  );
}

export default function BulkLogModal({ files, contractors, aiEnabled, month, onClose, onLogged }) {
  const [rows, setRows] = useState(() => files.map((f) => rowFor(f, month)));
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [finished, setFinished] = useState(null);
  const fileInput = useRef(null);
  // Which rows are being read right now. A ref, not state: it must be true the
  // moment a read starts, or the effect below would start the same file twice.
  const reading = useRef(new Set());

  const patch = useCallback((id, changes) => {
    setRows((list) => list.map((r) => (r.id === id ? { ...r, ...changes } : r)));
  }, []);

  // Read one invoice: the same endpoint the single log form uses, so a batch
  // and a one-off can't read the same document differently.
  const read = useCallback(
    async (row) => {
      reading.current.add(row.id);
      patch(row.id, { state: 'reading', error: null, readFailed: false });
      try {
        const d = await api.contractorInvoices.extract(row.file);
        setRows((list) =>
          list.map((r) =>
            r.id === row.id
              ? {
                  ...r,
                  state: 'ready',
                  duplicates: d.duplicates || null,
                  nameOnInvoice: d.contractor_name || null,
                  mismatch: !!d.contractor_mismatch,
                  regionReason: d.region ? null : d.region_reason || null,
                  note: d.caution ? `Check these: ${d.caution}` : null,
                  fields: {
                    ...r.fields,
                    contractor_id: d.contractor_id || r.fields.contractor_id,
                    invoice_number: d.invoice_number || r.fields.invoice_number,
                    invoice_date: d.invoice_date || r.fields.invoice_date,
                    property: d.property || r.fields.property,
                    description: d.description || r.fields.description,
                    net_amount: d.net_amount ?? r.fields.net_amount,
                    vat_amount: d.vat_amount ?? r.fields.vat_amount,
                    total_amount: d.total_amount ?? r.fields.total_amount,
                    region: d.region || r.fields.region,
                  },
                }
              : r,
          ),
        );
      } catch (e) {
        // A document that couldn't be read is still an invoice: the row stays,
        // ready to be typed in or read again.
        patch(row.id, {
          state: 'ready',
          readFailed: true,
          note: `Couldn’t read this one (${e.message}) — type it in.`,
        });
      } finally {
        reading.current.delete(row.id);
      }
    },
    [patch],
  );

  // Keep READERS files in flight until the queue is empty. Runs on every change
  // to the list, which is also what starts files dropped in later.
  useEffect(() => {
    if (!aiEnabled) {
      // Nothing to read them with — the batch is still worth having, it just
      // gets typed in.
      setRows((list) => list.map((r) => (r.state === 'queued' ? { ...r, state: 'ready' } : r)));
      return;
    }
    const queued = rows.filter((r) => r.state === 'queued' && !reading.current.has(r.id));
    const slots = READERS - reading.current.size;
    queued.slice(0, Math.max(0, slots)).forEach(read);
  }, [rows, read, aiEnabled]);

  const addFiles = (list) => {
    const added = Array.from(list || []).filter(Boolean);
    if (added.length) setRows((prev) => [...prev, ...added.map((f) => rowFor(f, month))]);
  };

  const pending = rows.filter((r) => r.state !== 'saved');
  const busyReading = rows.some((r) => r.state === 'queued' || r.state === 'reading');
  const ready = pending.filter((r) => !blocked(r));
  const needsWork = pending.length - ready.length;

  // Log the batch. One at a time and in order: two invoices from the same
  // contractor with the same number must meet the unique index one after the
  // other, not race it, and a row that fails has to leave the others alone.
  async function submit() {
    setSubmitting(true);
    setFinished(null);
    const done = [];
    for (const row of rows) {
      if (row.state === 'saved' || blocked(row)) continue;
      patch(row.id, { state: 'saving', error: null });
      try {
        const f = row.fields;
        // eslint-disable-next-line no-await-in-loop
        const saved = await api.contractorInvoices.create(
          {
            ...f,
            net_amount: f.net_amount === '' ? undefined : Number(f.net_amount),
            vat_amount: f.vat_amount === '' ? undefined : Number(f.vat_amount),
            total_amount: f.total_amount === '' ? undefined : Number(f.total_amount),
            extracted: aiEnabled,
          },
          row.file,
        );
        done.push(saved);
        patch(row.id, { state: 'saved', saved, error: null });
      } catch (e) {
        patch(row.id, { state: 'error', error: e.message });
      }
    }
    setSubmitting(false);
    setFinished({ logged: done.length });
    // The list behind this dialog is now out of date whatever happened next.
    if (done.length) onLogged(done);
  }

  const outstanding = rows.filter((r) => r.state !== 'saved').length;

  return (
    <Modal
      wide
      title={`Log ${rows.length} contractor invoice${rows.length === 1 ? '' : 's'}`}
      onClose={onClose}
      footer={
        <>
          <div className="bulk-summary muted">
            {busyReading
              ? `Reading ${rows.filter((r) => r.state === 'reading').length} of ${
                  rows.filter((r) => r.state === 'queued' || r.state === 'reading').length
                } still to read…`
              : finished
                ? `Logged ${finished.logged}${outstanding ? ` · ${outstanding} still here` : ''}`
                : `${ready.length} ready${needsWork ? ` · ${needsWork} need${needsWork === 1 ? 's' : ''} something` : ''}`}
          </div>
          <button type="button" className="btn" onClick={onClose}>
            {outstanding ? 'Cancel the rest' : 'Close'}
          </button>
          {/* Nothing left to log means the batch is done: one Close, and no
              dead button offering to log nothing. */}
          {pending.length > 0 && (
            <button
              type="button"
              className="btn-primary"
              disabled={submitting || busyReading || !ready.length}
              onClick={submit}
            >
              {submitting
                ? 'Logging…'
                : ready.length === pending.length
                  ? `Log ${ready.length} invoice${ready.length === 1 ? '' : 's'}`
                  : `Log the ${ready.length} that ${ready.length === 1 ? 'is' : 'are'} ready`}
            </button>
          )}
        </>
      }
    >
      <div
        className={`dropzone ${dragOver ? 'over' : ''}`}
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
          // First, so the page behind this dialog stands down and the browser
          // doesn't navigate to the file.
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
        style={{ marginBottom: 16 }}
      >
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".pdf,.docx,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <div>Drop more invoices here, or click to choose</div>
        <div className="dz-hint">
          They join the batch and are read while you check the rest
          {aiEnabled ? '' : ' — automatic reading is off, so these are typed in'}
        </div>
      </div>

      {rows.map((row) => (
        <BulkRow
          key={row.id}
          row={row}
          contractors={contractors}
          onChange={(fields) => patch(row.id, { fields })}
          onRemove={() => setRows((list) => list.filter((r) => r.id !== row.id))}
          onRetry={() => patch(row.id, { state: 'queued', note: null, readFailed: false })}
        />
      ))}

      {!rows.length && (
        <div className="empty">
          Nothing in the batch. Drop the invoices above, or close this and log one at a time.
        </div>
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        Anything not shown here — a landlord reference, notes, commission on part of the invoice —
        can be set with <strong>Amend</strong> once the invoice is logged.
      </div>
    </Modal>
  );
}
