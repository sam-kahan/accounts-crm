import { formatMoney, monthLabel } from '../api';

// "Did we miss one?" — month end is worked a month at a time, so a month that
// was never raised just stops being looked at and the contractor is never
// asked for it. Both commission pages show this above whatever month is on
// screen: the earlier months that still have commission waiting, oldest first,
// each one a click away.
//
// It says the money first, because that is what makes someone look. Nothing to
// chase renders nothing at all — a banner that is always there is one nobody
// reads.
export default function OutstandingMonths({ data, month, onPick }) {
  const months = data?.months || [];
  if (!months.length) return null;

  const { month_count: count, pending_commission: total } = data.totals;

  return (
    <div className="inline-note warn" style={{ marginBottom: 12 }}>
      <strong>{formatMoney(total)} of commission from earlier months hasn’t been invoiced yet.</strong>{' '}
      {count === 1 ? 'One month' : `${count} months`} before {monthLabel(month)}{' '}
      {count === 1 ? 'still has' : 'still have'} lines waiting to be raised — check they weren’t
      missed:
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {months.map((m) => (
          <li key={m.month}>
            <button className="linkish" onClick={() => onPick(m.month)}>{m.label}</button>{' '}
            — {formatMoney(m.pending_commission)} from {m.pending_count}{' '}
            invoice{m.pending_count === 1 ? '' : 's'}, {m.contractor_count}{' '}
            contractor{m.contractor_count === 1 ? '' : 's'}
          </li>
        ))}
      </ul>
    </div>
  );
}
