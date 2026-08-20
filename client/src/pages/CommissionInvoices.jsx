import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  formatDate,
  formatMoney,
  monthOf,
  monthLabel,
  INVOICE_STATUS_LABEL,
} from '../api';

const STATUS_BADGE = { draft: 'grey', sent: 'amber', paid: 'ok', void: 'red' };

export default function CommissionInvoices() {
  const [params, setParams] = useSearchParams();
  const month = params.get('month') || monthOf();

  const [summary, setSummary] = useState(null);
  const [invoices, setInvoices] = useState(null);
  const [err, setErr] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState(null);

  const setMonth = (m) => {
    const next = new URLSearchParams(params);
    next.set('month', m);
    setParams(next, { replace: true });
  };

  const load = () => {
    setErr(null);
    return Promise.all([
      api.contractorInvoices.summary({ month }).then(setSummary),
      api.commissionInvoices.list().then(setInvoices),
    ]).catch((e) => setErr(e.message));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  // Raise the month's invoice for one contractor: every pending commission in
  // the period becomes a line on it.
  async function raise(row) {
    if (
      !confirm(
        `Raise a commission invoice to ${row.contractor_name} for ${formatMoney(
          row.pending_commission,
        )} (${row.pending_count} invoice(s), ${monthLabel(month)})?`,
      )
    ) {
      return;
    }
    setBusyId(row.contractor_id);
    setMsg(null);
    try {
      const res = await api.commissionInvoices.raise({
        contractor_id: row.contractor_id,
        month,
      });
      setMsg(
        `Raised ${res.invoice_number} for ${row.contractor_name} (${res.lines} line(s)).` +
          (res.pushed
            ? ` Sent to Greenco Invoicing as ${res.pushed.number}.`
            : res.push_error
              ? ` It could not be sent to Greenco Invoicing (${res.push_error}) — open it to retry.`
              : ''),
      );
      await load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusyId(null);
    }
  }

  const totals = summary?.totals;

  return (
    <>
      <div className="toolbar flex-between">
        <div className="btn-row">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            aria-label="Month"
          />
          <span className="muted">
            Commission collected by contractors in {monthLabel(month)}, ready to invoice back.
          </span>
        </div>
        <a className="btn" href={api.contractorInvoices.exportUrl({ month })}>Export CSV</a>
      </div>

      {err && (
        <div className="inline-note warn" style={{ marginBottom: 12 }}>
          {err} <button className="linkish" onClick={load}>Retry</button>
        </div>
      )}
      {msg && <div className="inline-note" style={{ marginBottom: 12 }}>{msg}</div>}

      {totals && (
        <div className="stat-row">
          <div className="stat accent">
            <div className="label">To invoice</div>
            <div className="value">{formatMoney(totals.pending_commission)}</div>
          </div>
          <div className="stat">
            <div className="label">Already invoiced</div>
            <div className="value">{formatMoney(totals.billed_commission)}</div>
          </div>
          <div className="stat">
            <div className="label">Contractor invoices</div>
            <div className="value">{totals.invoice_count}</div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>{monthLabel(month)} — by contractor</h2>
        </div>
        {!summary ? (
          err ? (
            <div className="empty">Couldn’t load the month.</div>
          ) : (
            <div className="spinner">Loading…</div>
          )
        ) : summary.contractors.length === 0 ? (
          <div className="empty">No contractor invoices logged in {monthLabel(month)}.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Contractor</th>
                <th className="num">Invoices</th>
                <th className="num">Paid to them</th>
                <th className="num">Commission</th>
                <th className="num">To invoice</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {summary.contractors.map((r) => (
                <tr key={r.contractor_id}>
                  <td>
                    <strong>{r.contractor_name}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>{r.contractor_email || '—'}</div>
                  </td>
                  <td className="num muted">{r.invoice_count}</td>
                  <td className="num muted">{formatMoney(r.invoiced_total)}</td>
                  <td className="num">{formatMoney(r.commission_total)}</td>
                  <td className="num">
                    <strong>{formatMoney(r.pending_commission, { blankZero: true })}</strong>
                    {r.pending_count > 0 && (
                      <div className="muted" style={{ fontSize: 12 }}>{r.pending_count} line(s)</div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Link
                      className="btn-ghost btn-sm"
                      to={`/commission/invoices?month=${month}&contractor_id=${r.contractor_id}`}
                    >
                      View lines
                    </Link>
                    <button
                      className="btn-primary btn-sm"
                      disabled={busyId === r.contractor_id || Number(r.pending_commission) <= 0}
                      onClick={() => raise(r)}
                      title={
                        Number(r.pending_commission) > 0
                          ? 'Raise the commission invoice for this month'
                          : 'Nothing left to invoice for this month'
                      }
                    >
                      {busyId === r.contractor_id ? 'Raising…' : 'Raise invoice'}
                    </button>
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td>Total</td>
                <td className="num">{totals.invoice_count}</td>
                <td className="num">{formatMoney(totals.invoiced_total)}</td>
                <td className="num">{formatMoney(totals.commission_total)}</td>
                <td className="num">{formatMoney(totals.pending_commission)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </div>

      <div className="section-title">Commission invoices raised</div>
      <div className="card">
        {!invoices ? (
          <div className="spinner">Loading…</div>
        ) : invoices.length === 0 ? (
          <div className="empty">None yet — raise one from the table above.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Number</th>
                <th>Contractor</th>
                <th>Period</th>
                <th>Issued</th>
                <th>Due</th>
                <th className="num">Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td>
                    <Link to={`/commission/raised/${i.id}`} style={{ color: 'var(--green-600)' }}>
                      <strong>{i.external_number || i.invoice_number}</strong>
                    </Link>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {i.line_count} line(s)
                      {i.external_number ? ` · ${i.invoice_number}` : ''}
                    </div>
                    {i.external_error && (
                      <span className="badge amber" title={i.external_error}>not in invoicing</span>
                    )}
                  </td>
                  <td>{i.contractor_name}</td>
                  <td className="muted">
                    {formatDate(i.period_start)} – {formatDate(i.period_end)}
                  </td>
                  <td className="muted">{formatDate(i.issue_date)}</td>
                  <td className="muted">{formatDate(i.due_date)}</td>
                  <td className="num"><strong>{formatMoney(i.total_amount)}</strong></td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[i.status] || 'grey'}`}>
                      {INVOICE_STATUS_LABEL[i.status] || i.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
