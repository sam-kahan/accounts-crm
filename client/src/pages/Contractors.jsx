import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatMoney } from '../api';
import Modal from '../components/Modal.jsx';

// The commission agreement is the whole point of a contractor record: set it
// once here and every invoice logged against them is costed automatically.
const EMPTY = {
  name: '', trade: '', contact_name: '', email: '', phone: '', address: '',
  commission_type: 'percentage', commission_rate: '', commission_fixed: '',
  commission_on: 'net', commission_basis: 'markup', commission_vat_rate: '',
  payment_terms_days: '', vat_registered: true, agreement_notes: '', active: true, notes: '',
};

function num(v) {
  return v === '' || v === null || v === undefined ? undefined : Number(v);
}

function ContractorModal({ initial, defaults, onClose, onSaved }) {
  const [form, setForm] = useState(
    initial ? { ...EMPTY, ...initial } : { ...EMPTY, ...(defaults || {}) },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const isFixed = form.commission_type === 'fixed';

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const payload = {
      ...form,
      commission_rate: num(form.commission_rate) ?? 0,
      commission_fixed: num(form.commission_fixed) ?? 0,
      commission_vat_rate: num(form.commission_vat_rate) ?? 0,
      payment_terms_days: num(form.payment_terms_days) ?? 30,
    };
    try {
      const saved = initial?.id
        ? await api.contractors.update(initial.id, payload)
        : await api.contractors.create(payload);
      onSaved(saved);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={initial?.id ? `Edit ${initial.name}` : 'Add contractor'} onClose={onClose}>
      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}
      <form onSubmit={save}>
        <div className="form-grid">
          <label className="field">
            <span className="lbl">Name *</span>
            <input required value={form.name} onChange={(e) => set('name', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Trade</span>
            <input
              value={form.trade || ''}
              onChange={(e) => set('trade', e.target.value)}
              placeholder="e.g. Plumber"
            />
          </label>
          <label className="field">
            <span className="lbl">Contact name</span>
            <input value={form.contact_name || ''} onChange={(e) => set('contact_name', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Email</span>
            <input
              type="email"
              value={form.email || ''}
              onChange={(e) => set('email', e.target.value)}
              placeholder="Where the commission invoice goes"
            />
          </label>
          <label className="field">
            <span className="lbl">Phone</span>
            <input value={form.phone || ''} onChange={(e) => set('phone', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Payment terms (days)</span>
            <input
              type="number"
              min="0"
              value={form.payment_terms_days ?? ''}
              onChange={(e) => set('payment_terms_days', e.target.value)}
              placeholder="30"
            />
          </label>
          <label className="field full">
            <span className="lbl">Address</span>
            <textarea rows={2} value={form.address || ''} onChange={(e) => set('address', e.target.value)} />
          </label>
        </div>

        <div className="section-title" style={{ marginTop: 8 }}>Commission agreement</div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
          Applied automatically to every invoice logged against this contractor. Changing it
          only affects invoices logged from now on — what’s already billed keeps its own rate.
        </div>

        <div className="form-grid">
          <label className="field">
            <span className="lbl">Commission is</span>
            <select value={form.commission_type} onChange={(e) => set('commission_type', e.target.value)}>
              <option value="percentage">A percentage of the invoice</option>
              <option value="fixed">A fixed amount per invoice</option>
            </select>
          </label>
          {isFixed ? (
            <label className="field">
              <span className="lbl">Amount per invoice (£)</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.commission_fixed ?? ''}
                onChange={(e) => set('commission_fixed', e.target.value)}
              />
            </label>
          ) : (
            <label className="field">
              <span className="lbl">Rate (%)</span>
              <input
                type="number"
                step="0.001"
                min="0"
                max="100"
                value={form.commission_rate ?? ''}
                onChange={(e) => set('commission_rate', e.target.value)}
                placeholder="10"
              />
            </label>
          )}
          {!isFixed && (
            <label className="field">
              <span className="lbl">Calculated on</span>
              <select value={form.commission_on} onChange={(e) => set('commission_on', e.target.value)}>
                <option value="net">The net (before VAT)</option>
                <option value="gross">The gross (including VAT)</option>
              </select>
            </label>
          )}
          <label className="field full">
            <span className="lbl">How the percentage works</span>
            <select value={form.commission_basis} onChange={(e) => set('commission_basis', e.target.value)}>
              <option value="markup">
                They add it to their own price, and invoice us the total (usual)
              </option>
              <option value="inclusive">It is that percentage of the invoice they send us</option>
              <option value="on_top">We charge it on top of what they invoice us</option>
            </select>
            <span className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {form.commission_basis === 'markup'
                ? `They want £90, add ${form.commission_rate || 10}%, invoice us ${
                    form.commission_rate ? '' : 'e.g. '
                  }£${(90 * (1 + (Number(form.commission_rate) || 10) / 100)).toFixed(2)} — and £${(
                    (90 * (Number(form.commission_rate) || 10)) / 100
                  ).toFixed(2)} of that is ours.`
                : form.commission_basis === 'inclusive'
                  ? `They invoice us £99 and ${form.commission_rate || 10}% of it — £${(
                      (99 * (Number(form.commission_rate) || 10)) / 100
                    ).toFixed(2)} — is ours.`
                  : `They invoice us £90 for their work, and we bill them £${(
                      (90 * (Number(form.commission_rate) || 10)) / 100
                    ).toFixed(2)} on top.`}
            </span>
          </label>
          <label className="field full" style={{ gap: 6 }}>
            <span className="lbl">Is the contractor VAT registered?</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={!!form.vat_registered}
                onChange={(e) => set('vat_registered', e.target.checked)}
                style={{ width: 'auto' }}
              />
              <span>Yes — they charge VAT on their invoices</span>
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              {form.vat_registered
                ? 'They collect the VAT on our commission within their own invoice, so we bill the commission plus VAT on top.'
                : 'They can’t charge VAT, so the commission they collect is treated as VAT-inclusive — we bill it netted down, and they pay back exactly what they took.'}
            </span>
          </label>
          <label className="field">
            <span className="lbl">VAT on our commission invoice (%)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={form.commission_vat_rate ?? ''}
              onChange={(e) => set('commission_vat_rate', e.target.value)}
              placeholder="0"
            />
          </label>
          <label className="field full">
            <span className="lbl">What was agreed</span>
            <textarea
              rows={2}
              value={form.agreement_notes || ''}
              onChange={(e) => set('agreement_notes', e.target.value)}
              placeholder="e.g. 10% commission included on all works, invoiced back monthly"
            />
          </label>
          <label className="field full">
            <span className="lbl">Notes</span>
            <textarea rows={2} value={form.notes || ''} onChange={(e) => set('notes', e.target.value)} />
          </label>
        </div>

        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={!!form.active}
            onChange={(e) => set('active', e.target.checked)}
            style={{ width: 'auto' }}
          />
          <span>Active — show when logging invoices</span>
        </label>

        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Contractors() {
  const [rows, setRows] = useState(null);
  const [editing, setEditing] = useState(null); // contractor object or 'new'
  const [defaults, setDefaults] = useState(null);
  const [search, setSearch] = useState('');
  const [err, setErr] = useState(null);

  const load = () => {
    setErr(null);
    return api.contractors
      .list()
      .then(setRows)
      .catch((e) => setErr(e.message));
  };

  useEffect(() => {
    load();
    api.contractors.defaults().then(setDefaults).catch(() => setDefaults(null));
  }, []);

  async function remove(c) {
    if (!confirm(`Delete ${c.name}?`)) return;
    try {
      await api.contractors.remove(c.id);
      await load();
    } catch (e) {
      setErr(e.message);
    }
  }

  const visible = (rows || []).filter((c) =>
    !search.trim()
      ? true
      : `${c.name} ${c.trade || ''}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <>
      <div className="toolbar flex-between">
        <input
          type="search"
          placeholder="Search contractors…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn-primary" onClick={() => setEditing('new')}>+ Add contractor</button>
      </div>

      {err && (
        <div className="inline-note warn" style={{ marginBottom: 12 }}>
          {err} <button className="linkish" onClick={load}>Retry</button>
        </div>
      )}

      <div className="card">
        {!rows ? (
          err ? (
            <div className="empty">Couldn’t load contractors.</div>
          ) : (
            <div className="spinner">Loading…</div>
          )
        ) : visible.length === 0 ? (
          <div className="empty">
            {rows.length === 0
              ? 'No contractors yet. Add the ones who include commission in their invoices.'
              : 'No contractors match that search.'}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Contractor</th>
                <th>Commission agreed</th>
                <th className="num">Invoices</th>
                <th className="num">To invoice</th>
                <th className="num">Billed to date</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.id}>
                  <td
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    aria-label={`Edit ${c.name}`}
                    onClick={() => setEditing(c)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setEditing(c);
                      }
                    }}
                  >
                    <strong>{c.name}</strong>
                    {!c.active && <span className="badge grey" style={{ marginLeft: 8 }}>Inactive</span>}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {[c.trade, c.email].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </td>
                  <td>
                    <span className="badge green">{c.deal_summary}</span>
                    {Number(c.commission_vat_rate) > 0 && (
                      <span className="badge navy" style={{ marginLeft: 6 }}>
                        +{Number(c.commission_vat_rate)}% VAT
                      </span>
                    )}
                  </td>
                  <td className="num muted">{c.invoice_count || 0}</td>
                  <td className="num">
                    <strong>{formatMoney(c.pending_commission, { blankZero: true })}</strong>
                    {c.pending_count > 0 && (
                      <div className="muted" style={{ fontSize: 12 }}>{c.pending_count} invoice(s)</div>
                    )}
                  </td>
                  <td className="num muted">{formatMoney(c.billed_commission, { blankZero: true })}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Link className="btn-ghost btn-sm" to={`/commission/invoices?contractor_id=${c.id}`}>
                      Invoices
                    </Link>
                    <button className="btn-ghost btn-sm" onClick={() => setEditing(c)}>Edit</button>
                    <button className="btn-danger btn-sm" onClick={() => remove(c)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <ContractorModal
          initial={editing === 'new' ? null : editing}
          defaults={defaults}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}
