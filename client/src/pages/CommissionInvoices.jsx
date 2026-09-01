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
import MonthSelect from '../components/MonthSelect.jsx';
import OutstandingMonths from '../components/OutstandingMonths.jsx';

// A row is a contractor's work for ONE office: Manchester and Liverpool are
// separate companies and cannot share an invoice, so they are raised separately.
const rowKey = (r) => `${r.contractor_id}:${r.region}`;

const STATUS_BADGE = { draft: 'grey', sent: 'amber', paid: 'ok', void: 'red' };

export default function CommissionInvoices() {
  const [params, setParams] = useSearchParams();
  const month = params.get('month') || monthOf();

  const [summary, setSummary] = useState(null);
  const [invoices, setInvoices] = useState(null);
  const [settings, setSettings] = useState(null);
  // Earlier months that still owe something — the check against a month end
  // quietly never being done.
  const [outstanding, setOutstanding] = useState(null);
  // The raised list follows the month selector like everything else here —
  // showing every invoice ever raised under a heading that says August is how
  // June's invoice ends up on screen. Chasing an older one is a click away.
  const [allMonths, setAllMonths] = useState(false);
  // Raised here but never landed over there. Asked for separately because it is
  // not a question about the month on screen: one stranded in June is exactly
  // the one nobody would go looking for.
  const [unsent, setUnsent] = useState([]);
  // Voided here but still standing over there — the mirror of `unsent`, asked
  // for across every month for the same reason. A contractor being chased for
  // an invoice we withdrew won't wait for someone to open the right month.
  const [unwithdrawn, setUnwithdrawn] = useState([]);
  const [err, setErr] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [sendingId, setSendingId] = useState(null);
  const [msg, setMsg] = useState(null);

  const setMonth = (m) => {
    const next = new URLSearchParams(params);
    next.set('month', m);
    setParams(next, { replace: true });
  };

  const load = () => {
    setErr(null);
    // The missed-month check is a nicety: it must never be the reason the page
    // can't be read, so it fails quietly on its own.
    api.contractorInvoices
      .outstanding({ before: month })
      .then(setOutstanding)
      .catch(() => setOutstanding(null));
    api.commissionInvoices
      .list({ unsent: 'true' })
      .then(setUnsent)
      .catch(() => setUnsent([]));
    api.commissionInvoices
      .list({ unwithdrawn: 'true' })
      .then(setUnwithdrawn)
      .catch(() => setUnwithdrawn([]));
    return Promise.all([
      api.contractorInvoices.summary({ month }).then(setSummary),
      api.commissionInvoices.list(allMonths ? {} : { month }).then(setInvoices),
    ]).catch((e) => setErr(e.message));
  };

  // Which company each office invoices as, and whether it is linked to Greenco
  // Invoicing yet — better said before an invoice is raised than after.
  useEffect(() => {
    api.commissionInvoices.settings().then(setSettings).catch(() => setSettings(null));
  }, []);

  const officeOf = (region) =>
    settings?.regions?.find((r) => r.key === region)?.company_name || null;
  const unlinked = (settings?.invoicing?.enabled ? settings.invoicing.companies || [] : []).filter(
    (c) => !c.linked,
  );

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, allMonths]);

  // Raise the month's invoice for one contractor: every pending commission in
  // the period becomes a line on it.
  async function raise(row) {
    const from = officeOf(row.region) || row.region_label;
    // Say when part of it is late post from a month already invoiced — the
    // figure won't match that month's own total, and it should be obvious why.
    const carried = Number(row.carried_commission) > 0
      ? ` Includes ${formatMoney(row.carried_commission)} from ${row.carried_count} invoice(s) received after their own month was invoiced.`
      : '';
    const totalToRaise = row.raises ? row.raises.total_amount : row.pending_commission;
    if (
      !confirm(
        `Raise a commission invoice from ${from} to ${row.contractor_name} for ${formatMoney(
          totalToRaise,
        )} (${formatMoney(row.raises?.net_amount ?? row.pending_commission)} + VAT, from ${formatMoney(
          row.pending_commission,
        )} of commission on ${row.pending_count} invoice(s), ${monthLabel(month)}).${carried}`,
      )
    ) {
      return;
    }
    setBusyId(rowKey(row));
    setMsg(null);
    try {
      const res = await api.commissionInvoices.raise({
        contractor_id: row.contractor_id,
        region: row.region,
        month,
      });
      setMsg(
        `Raised ${res.invoice_number} from ${res.company_name} for ${row.contractor_name} (${res.lines} line(s)).` +
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

  // Invoices raised here that never made it across. Only worth saying when the
  // bridge is configured at all — without it nothing is ever pushed, and a
  // warning about that on every invoice would be noise.
  // Send (or re-send) one to Greenco Invoicing. The endpoint is idempotent —
  // our GC-COM number is the key at the other end.
  async function send(inv) {
    setSendingId(inv.id);
    setMsg(null);
    try {
      const res = await api.commissionInvoices.push(inv.id);
      setMsg(
        `${inv.invoice_number} sent to Greenco Invoicing${
          res.invoice?.external_number ? ` as ${res.invoice.external_number}` : ''
        }${res.created === false ? ' (it was already there — linked to it)' : ''}.`,
      );
      await load();
    } catch (e) {
      setMsg(`${inv.invoice_number} still couldn’t be sent: ${e.message}`);
    } finally {
      setSendingId(null);
    }
  }

  // The other half of a void: withdraw the document over there. Same shape as
  // `send` above and the same reasoning — a failure has to stay on screen.
  async function withdraw(inv) {
    const reason = prompt('Why was it withdrawn? (written onto the invoice over there)', '');
    if (reason === null) return;
    setSendingId(inv.id);
    setMsg(null);
    try {
      const res = await api.commissionInvoices.withdraw(inv.id, reason);
      setMsg(
        res.skipped ||
          `${inv.invoice_number} cancelled in Greenco Invoicing — it won’t be chased again.`,
      );
      await load();
    } catch (e) {
      setMsg(`${inv.invoice_number} still couldn’t be cancelled there: ${e.message}`);
    } finally {
      setSendingId(null);
    }
  }

  const totals = summary?.totals;

  return (
    <>
      <div className="toolbar flex-between">
        <div className="btn-row">
          <MonthSelect value={month} onChange={setMonth} />
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

      <OutstandingMonths data={outstanding} month={month} onPick={setMonth} />

      {unlinked.length > 0 && (
        <div className="inline-note warn" style={{ marginBottom: 12 }}>
          {unlinked.map((c) => c.company_name).join(' and ')}{' '}
          {unlinked.length > 1 ? 'are' : 'is'} not linked to a company in Greenco Invoicing yet, so{' '}
          {unlinked.length > 1 ? 'those offices’' : 'that office’s'} invoices will raise here but
          won’t be sent, emailed or chased there. Set{' '}
          {unlinked
            .map((c) => `INVOICING_COMPANY_ID_${c.region.toUpperCase()}`)
            .join(' and ')}{' '}
          in the server environment.
        </div>
      )}

      {totals && (
        <div className="stat-row">
          <div className="stat accent">
            <div className="label">To invoice</div>
            <div className="value">
              {formatMoney(totals.raises ? totals.raises.total_amount : 0)}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              {totals.raises && Number(totals.pending_commission) > 0
                ? `from ${formatMoney(totals.pending_commission)} of commission collected`
                : 'nothing left to raise'}
            </div>
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
                <th>Invoiced by</th>
                <th className="num">Invoices</th>
                <th className="num">Paid to them</th>
                <th className="num">Commission collected</th>
                <th className="num">Invoice to raise</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {summary.contractors.map((r) => (
                <tr key={rowKey(r)}>
                  <td>
                    <strong>{r.contractor_name}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>{r.contractor_email || '—'}</div>
                  </td>
                  <td>
                    {r.region_label}
                    <div className="muted" style={{ fontSize: 12 }}>{officeOf(r.region) || ''}</div>
                  </td>
                  <td className="num muted">{r.invoice_count}</td>
                  <td className="num muted">{formatMoney(r.invoiced_total)}</td>
                  <td className="num">{formatMoney(r.commission_total)}</td>
                  <td className="num">
                    {/* The INVOICE total leads, because that is the thing this
                        button is about to create and the figure that appears in
                        the raised list below. The commission collected is the
                        column to the left; showing it again here as the headline
                        is what made the two halves of the page look like they
                        disagreed. */}
                    <strong>
                      {formatMoney(r.raises ? r.raises.total_amount : 0, { blankZero: true })}
                    </strong>
                    {r.raises && Number(r.pending_commission) > 0 && (
                      <div className="cell-note muted">
                        {formatMoney(r.raises.net_amount)} + {formatMoney(r.raises.vat_amount)} VAT
                        {' · '}
                        {r.pending_count} line{r.pending_count === 1 ? '' : 's'}
                      </div>
                    )}
                    {Number(r.carried_commission) > 0 && (
                      <div className="cell-note muted">
                        incl. {formatMoney(r.carried_commission)} received late for an earlier month
                      </div>
                    )}
                    {Number(r.moved_commission) > 0 && (
                      <div className="cell-note" style={{ color: 'var(--warn)' }}>
                        {formatMoney(r.moved_commission)} arrived after {monthLabel(month)} was
                        invoiced — it goes on the next one
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <Link
                      className="btn-ghost btn-sm"
                      to={`/commission/invoices?month=${month}&contractor_id=${r.contractor_id}&region=${r.region}`}
                    >
                      View lines
                    </Link>
                    <button
                      className="btn-primary btn-sm"
                      disabled={busyId === rowKey(r) || Number(r.pending_commission) <= 0}
                      onClick={() => raise(r)}
                      title={
                        Number(r.pending_commission) > 0
                          ? 'Raise the commission invoice for this month'
                          : 'Nothing left to invoice for this month'
                      }
                    >
                      {busyId === rowKey(r) ? 'Raising…' : 'Raise invoice'}
                    </button>
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td colSpan={2}>Total</td>
                <td className="num">{totals.invoice_count}</td>
                <td className="num">{formatMoney(totals.invoiced_total)}</td>
                <td className="num">{formatMoney(totals.commission_total)}</td>
                <td className="num">
                  {formatMoney(totals.raises ? totals.raises.total_amount : 0)}
                  {totals.raises && Number(totals.pending_commission) > 0 && (
                    <div className="cell-note muted">
                      from {formatMoney(totals.pending_commission)} collected
                    </div>
                  )}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {settings?.invoicing?.enabled && unsent.length > 0 && (
        <div className="inline-note warn" style={{ margin: '20px 0 12px' }}>
          <strong>
            {unsent.length === 1
              ? 'One commission invoice hasn’t reached Greenco Invoicing.'
              : `${unsent.length} commission invoices haven’t reached Greenco Invoicing.`}
          </strong>{' '}
          {unsent.length === 1 ? 'It won’t be' : 'They won’t be'} emailed, chased or paid there
          until {unsent.length === 1 ? 'it is' : 'they are'} sent. Sending again is safe — our
          reference is the key over there, so it links to any invoice already raised rather than
          billing twice.
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {unsent.map((i) => (
              <li key={i.id} style={{ marginBottom: 4 }}>
                <Link to={`/commission/raised/${i.id}`} style={{ color: 'var(--green-600)' }}>
                  <strong>{i.invoice_number}</strong>
                </Link>{' '}
                — {i.contractor_name}, {formatMoney(i.total_amount)}
                {i.external_error ? ` · ${i.external_error}` : ''}{' '}
                <button
                  className="btn-ghost btn-sm"
                  disabled={sendingId === i.id}
                  onClick={() => send(i)}
                >
                  {sendingId === i.id ? 'Sending…' : 'Send it now'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {settings?.invoicing?.enabled && unwithdrawn.length > 0 && (
        <div className="inline-note warn" style={{ margin: '20px 0 12px' }}>
          <strong>
            {unwithdrawn.length === 1
              ? 'One voided invoice still stands in Greenco Invoicing.'
              : `${unwithdrawn.length} voided invoices still stand in Greenco Invoicing.`}
          </strong>{' '}
          The commission is back on the “to invoice” list here, but the contractor is still being
          chased over there — and will hold two invoices once the corrected month end goes out.
          Cancelling again is safe: an invoice already cancelled just reports back as cancelled.
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {unwithdrawn.map((i) => (
              <li key={i.id} style={{ marginBottom: 4 }}>
                <Link to={`/commission/raised/${i.id}`} style={{ color: 'var(--green-600)' }}>
                  <strong>{i.invoice_number}</strong>
                </Link>{' '}
                — {i.contractor_name}, {formatMoney(i.total_amount)}
                {i.external_number ? ` · ${i.external_number} there` : ''}
                {i.external_error ? ` · ${i.external_error}` : ''}{' '}
                <button
                  className="btn-ghost btn-sm"
                  disabled={sendingId === i.id}
                  onClick={() => withdraw(i)}
                >
                  {sendingId === i.id ? 'Cancelling…' : 'Cancel it there'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        <strong>Commission collected</strong> is what the contractors took inside their own
        invoices. <strong>Invoice to raise</strong> is what we bill back, which is a different
        figure and differs in opposite directions. A contractor who is <strong>VAT registered</strong>{' '}
        collected the commission net, so VAT goes on top: £50.00 collected → £50.00 + £10.00 =
        <strong> £60.00</strong> invoiced. One who is <strong>not</strong> only ever collected that
        much in total, so it is treated as VAT-inclusive and invoiced netted down: £10.05 collected
        → £8.37 + £1.67 = <strong>£10.04</strong> invoiced — the same money, split out of what they
        already took, which is why the two columns can look alike for them. The right-hand figure
        is the one that appears in the list below.
      </div>

      <div className="section-title flex-between">
        <span>
          Commission invoices raised{allMonths ? '' : ` for ${monthLabel(month)}`}
        </span>
        <button className="linkish" onClick={() => setAllMonths((v) => !v)}>
          {allMonths ? `Show ${monthLabel(month)} only` : 'Show every month'}
        </button>
      </div>
      <div className="card">
        {!invoices ? (
          <div className="spinner">Loading…</div>
        ) : invoices.length === 0 ? (
          <div className="empty">
            {allMonths
              ? 'None raised yet — raise one from the table above.'
              : `Nothing raised for ${monthLabel(month)} yet — raise one from the table above.`}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Number</th>
                <th>Contractor</th>
                <th>Invoiced by</th>
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
                    {/* No external id means it never got there — with or
                        without a recorded reason. Either way it is not being
                        emailed or chased, which is the whole point of sending
                        it, so it says so on the row rather than only on the
                        message that flashed up when it was raised. */}
                    {i.status !== 'void' && !i.external_id && (
                      <span
                        className="badge amber"
                        title={i.external_error || 'It has not been sent to Greenco Invoicing'}
                      >
                        not in invoicing
                      </span>
                    )}
                  </td>
                  <td>{i.contractor_name}</td>
                  <td className="muted">{i.company_name || i.region_label || '—'}</td>
                  <td className="muted">
                    {formatDate(i.period_start)} - {formatDate(i.period_end)}
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
