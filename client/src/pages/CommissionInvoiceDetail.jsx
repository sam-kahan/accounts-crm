import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate, formatMoney, INVOICE_STATUS_LABEL, todayISO } from '../api';
import Modal from '../components/Modal.jsx';

const STATUS_BADGE = { draft: 'grey', sent: 'amber', paid: 'ok', void: 'red' };

function SendModal({ invoice, onClose, onSent }) {
  const [to, setTo] = useState(invoice.contractor_email || '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function send(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.commissionInvoices.send(invoice.id, { to, message });
      onSent(res);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Email ${invoice.invoice_number}`} onClose={onClose}>
      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}
      <form onSubmit={send}>
        <label className="field">
          <span className="lbl">To *</span>
          <input required type="email" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="field">
          <span className="lbl">Note to add to the invoice</span>
          <textarea
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Optional — appears under the totals."
          />
        </label>
        <div className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
          The invoice is laid out in the email itself, listing every invoice the commission came
          from, so the contractor can check it line by line.
        </div>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Send invoice'}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function CommissionInvoiceDetail() {
  const { id } = useParams();
  const [inv, setInv] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setErr(null);
    return api.commissionInvoices
      .get(id)
      .then(setInv)
      .catch((e) => setErr(e.message));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!inv) {
    if (err) {
      return (
        <div className="card">
          <div className="inline-note warn" style={{ marginBottom: 12 }}>{err}</div>
          <button className="btn-primary btn-sm" onClick={load}>Retry</button>
        </div>
      );
    }
    return <div className="spinner">Loading invoice…</div>;
  }

  const b = inv.billing || {};
  const invoicing = inv.invoicing;
  const hasVat = Number(inv.vat_rate) > 0;
  // Lines dated outside the period: invoices that arrived after their own month
  // had been billed, carried onto this one.
  const carried = (inv.lines || []).filter(
    (l) => l.invoice_date < inv.period_start || l.invoice_date > inv.period_end,
  ).length;

  // Push it to Greenco Invoicing, which raises the numbered invoice the
  // contractor receives and takes over emailing and chasing it.
  async function pushToInvoicing() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.commissionInvoices.push(inv.id);
      await load();
      setMsg(
        res.created
          ? `Sent to Greenco Invoicing as ${res.invoice.external_number}.`
          : `Already in Greenco Invoicing as ${res.invoice.external_number} — link refreshed.`,
      );
    } catch (e) {
      setMsg(e.message);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function refreshFromInvoicing() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.commissionInvoices.refresh(inv.id);
      await load();
      setMsg(
        `Greenco Invoicing says ${res.external.status} — ${
          res.external.outstanding > 0
            ? `${formatMoney(res.external.outstanding)} still outstanding.`
            : 'nothing outstanding.'
        }`,
      );
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(status) {
    if (status === 'void' && !confirm('Void this invoice? Its lines go back to “to invoice”.')) {
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.commissionInvoices.setStatus(inv.id, status, status === 'paid' ? todayISO() : null);
      await load();
      setMsg(
        status === 'paid'
          ? 'Marked paid.'
          : status === 'void'
            ? 'Voided — the commission is back on the “to invoice” list.'
            : `Marked ${status}.`,
      );
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="toolbar flex-between no-print">
        <Link className="linkish" to="/commission/raised">← All commission invoices</Link>
        <div className="btn-row">
          <span className={`badge ${STATUS_BADGE[inv.status] || 'grey'}`}>
            {INVOICE_STATUS_LABEL[inv.status] || inv.status}
          </span>
          <button className="btn" onClick={() => window.print()}>Print / save PDF</button>
          {inv.status !== 'void' && !inv.external_id && (
            <button className="btn-navy" onClick={() => setSending(true)}>Email to contractor</button>
          )}
          {invoicing?.enabled && inv.status !== 'void' && (
            <button className="btn-navy" disabled={busy} onClick={pushToInvoicing}>
              {inv.external_id ? 'Re-send to invoicing' : 'Send to invoicing'}
            </button>
          )}
          {invoicing?.enabled && inv.external_id && (
            <button className="btn" disabled={busy} onClick={refreshFromInvoicing}>
              Refresh status
            </button>
          )}
          {inv.status !== 'paid' && inv.status !== 'void' && (
            <button className="btn-primary" disabled={busy} onClick={() => changeStatus('paid')}>
              Mark paid
            </button>
          )}
          {inv.status === 'paid' && (
            <button className="btn" disabled={busy} onClick={() => changeStatus('sent')}>
              Mark unpaid
            </button>
          )}
          {inv.status !== 'void' && (
            <button className="btn-danger" disabled={busy} onClick={() => changeStatus('void')}>
              Void
            </button>
          )}
        </div>
      </div>

      {msg && <div className="inline-note no-print" style={{ marginBottom: 12 }}>{msg}</div>}
      {/* Only worth saying when this copy is the one that gets sent. With the
          bridge on, the contractor's invoice comes from Greenco Invoicing,
          which carries its own company and bank details. */}
      {!b.complete && !invoicing?.enabled && (
        <div className="inline-note warn no-print" style={{ marginBottom: 12 }}>
          Your address and bank details are missing from the invoice. Set <code>BILLING_ADDRESS</code>{' '}
          and <code>BILLING_BANK_DETAILS</code> in the server .env so the contractor knows where to pay.
        </div>
      )}

      {invoicing?.enabled && (
        <div
          className={`inline-note ${inv.external_error ? 'warn' : ''} no-print`}
          style={{ marginBottom: 12 }}
        >
          {inv.external_id ? (
            <>
              In Greenco Invoicing as <strong>{inv.external_number}</strong>
              {inv.external_status ? ` (${inv.external_status})` : ''}, under{' '}
              {inv.company_name} — emailing and chasing happen there.{' '}
              {inv.external_url && (
                <a href={inv.external_url} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
                  Open it
                </a>
              )}
            </>
          ) : inv.external_error ? (
            <>Not sent to Greenco Invoicing: {inv.external_error}</>
          ) : (
            <>Not sent to Greenco Invoicing yet.</>
          )}
        </div>
      )}

      <div className="invoice-sheet">
        <div className="inv-head">
          <div>
            <h2>Commission invoice</h2>
            <div className="muted">
              {b.name || 'Greenco'}
              {inv.region_label ? ` · ${inv.region_label}` : ''}
            </div>
          </div>
          <div className="inv-meta">
            <div><strong>{inv.external_number || inv.invoice_number}</strong></div>
            {inv.external_number && <div>Our ref {inv.invoice_number}</div>}
            <div>Issued {formatDate(inv.issue_date)}</div>
            <div>Payment due {formatDate(inv.due_date)}</div>
            {inv.paid_on && <div>Paid {formatDate(inv.paid_on)}</div>}
          </div>
        </div>

        <div className="inv-parties">
          <div>
            <div className="lbl">From</div>
            <address>
              <strong>{b.name || 'Greenco'}</strong>
              {b.address ? `\n${b.address}` : ''}
              {b.email ? `\n${b.email}` : ''}
              {b.phone ? `\n${b.phone}` : ''}
              {b.vat_number ? `\nVAT ${b.vat_number}` : ''}
              {b.company_number ? `\nCo. no. ${b.company_number}` : ''}
            </address>
          </div>
          <div>
            <div className="lbl">To</div>
            <address>
              <strong>{inv.contractor_name}</strong>
              {inv.contractor_contact ? `\n${inv.contractor_contact}` : ''}
              {inv.contractor_address ? `\n${inv.contractor_address}` : ''}
              {inv.contractor_email ? `\n${inv.contractor_email}` : ''}
            </address>
          </div>
          <div>
            <div className="lbl">Period</div>
            <div>
              {formatDate(inv.period_start)} - {formatDate(inv.period_end)}
            </div>
            {/* Late post: an invoice that arrived after its own month was
                billed is carried here, keeping its own date. Say so, or the
                dates in the table look like a mistake. */}
            {carried > 0 && (
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                Includes {carried} invoice{carried === 1 ? '' : 's'} received after
                {carried === 1 ? ' its' : ' their'} own month was invoiced
              </div>
            )}
          </div>
        </div>

        <p style={{ fontSize: 13 }}>
          Commission included in the invoices below, now due back to {b.name || 'Greenco'}.
        </p>

        <table>
          <thead>
            <tr>
              <th>Invoice date</th>
              <th>Your invoice</th>
              <th>Property / works</th>
              <th className="num">Invoice total</th>
              <th className="num">Rate</th>
              <th className="num">Commission</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l) => (
              <tr key={l.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{formatDate(l.invoice_date)}</td>
                <td>{l.invoice_number || '—'}</td>
                <td>
                  {l.property || l.description || 'Works'}
                  {l.property && l.description && (
                    <div className="muted" style={{ fontSize: 12 }}>{l.description}</div>
                  )}
                </td>
                <td className="num">{formatMoney(l.total_amount)}</td>
                <td className="num muted">{Number(l.commission_rate) ? `${Number(l.commission_rate)}%` : '—'}</td>
                <td className="num">
                  {formatMoney(l.commission_net ?? l.commission_amount)}
                  {l.commission_vat_inclusive && (
                    <div className="muted" style={{ fontSize: 11 }}>
                      {formatMoney(l.commission_amount)} inc VAT
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {hasVat && (
              <tr>
                <td colSpan={5} className="num"><strong>Commission total</strong></td>
                <td className="num"><strong>{formatMoney(inv.net_amount)}</strong></td>
              </tr>
            )}
            {hasVat && (
              <tr>
                <td colSpan={5} className="num">VAT ({Number(inv.vat_rate)}%)</td>
                <td className="num">{formatMoney(inv.vat_amount)}</td>
              </tr>
            )}
            <tr className="total-row">
              <td colSpan={5} className="num">Total due</td>
              <td className="num">{formatMoney(inv.total_amount)}</td>
            </tr>
          </tbody>
        </table>

        {inv.notes && <p style={{ fontSize: 13, marginTop: 16 }}>{inv.notes}</p>}

        {b.bank_details && (
          <div className="pay-box">
            <strong>Payment details</strong>
            {`\n${b.bank_details}`}
          </div>
        )}

        <div className="inv-foot">
          {inv.sent_at && <>Emailed to {inv.sent_to} on {formatDate(inv.sent_at)}. </>}
          Any query on this invoice, please quote {inv.external_number || inv.invoice_number}.
        </div>
      </div>

      {sending && (
        <SendModal
          invoice={inv}
          onClose={() => setSending(false)}
          onSent={(res) => {
            setSending(false);
            setMsg(`Invoice emailed to ${res.to}.`);
            load();
          }}
        />
      )}
    </>
  );
}
