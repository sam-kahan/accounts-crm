import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate, daysUntil } from '../api';

const CATEGORY_LABEL = {
  year_end: 'Year end',
  accounts: 'Accounts',
  confirmation_statement: 'Confirmation stmt',
  corporation_tax: 'Corp tax',
  vat: 'VAT',
  paye: 'PAYE',
  custom: 'Other',
};

function DueBadge({ date }) {
  const n = daysUntil(date);
  if (n === null) return null;
  if (n < 0) return <span className="badge red">{Math.abs(n)}d overdue</span>;
  if (n === 0) return <span className="badge amber">Due today</span>;
  if (n <= 14) return <span className="badge amber">in {n}d</span>;
  return <span className="badge grey">in {n}d</span>;
}

function ItemRow({ item, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const recurring = item.type === 'key_date' && item.category === 'year_end';
  return (
    <tr>
      <td className={`due ${item.overdue ? 'overdue' : 'soon'}`}>
        {formatDate(item.due_date)}
      </td>
      <td>
        {item.label}
        {item.type === 'key_date' && item.category && (
          <span className="badge navy" style={{ marginLeft: 8 }}>
            {CATEGORY_LABEL[item.category] || item.category}
          </span>
        )}
        {item.type === 'task' && (
          <span className={`badge ${item.priority}`} style={{ marginLeft: 8 }}>
            {item.priority}
          </span>
        )}
      </td>
      <td className="muted">{item.company_name || '—'}</td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <DueBadge date={item.due_date} />
        <button
          className="btn-ghost btn-sm"
          style={{ marginLeft: 8 }}
          disabled={busy}
          title={
            recurring
              ? 'Dismiss — rolls forward to next year'
              : 'Dismiss this reminder'
          }
          onClick={async () => {
            setBusy(true);
            try {
              await onDismiss(item);
            } catch {
              setBusy(false);
            }
          }}
        >
          {busy ? '…' : 'Dismiss'}
        </button>
      </td>
    </tr>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState(null);

  const [loadError, setLoadError] = useState(null);
  const load = () => {
    setLoadError(null);
    return api
      .dashboard(90)
      .then(setData)
      .catch((e) => setLoadError(e.message));
  };
  useEffect(() => {
    load();
  }, []);

  // Dismiss a dashboard reminder. Recurring key dates (year end) roll forward
  // to next year; one-off key dates are marked done; tasks are marked done.
  async function dismiss(item) {
    if (item.type === 'key_date') {
      await api.keyDates.complete(item.id);
    } else {
      await api.tasks.update(item.id, { status: 'done' });
    }
    await load();
  }

  async function sendReminders() {
    setSending(true);
    setMsg(null);
    try {
      // Email the same window that's shown on screen (next 90 days).
      const res = await api.sendReminders(90);
      setMsg(
        res.sent
          ? `Reminder email sent to ${res.to.join(', ')} (${res.items} item(s)).`
          : `Email not sent: ${res.reason}. Configure SMTP2GO in the server .env.`,
      );
    } catch (e) {
      setMsg(e.message);
    } finally {
      setSending(false);
    }
  }

  if (!data) {
    if (loadError) {
      return (
        <div className="card">
          <div className="inline-note warn" style={{ marginBottom: 12 }}>
            Couldn’t load the dashboard: {loadError}
          </div>
          <button className="btn-primary btn-sm" onClick={load}>Retry</button>
        </div>
      );
    }
    return <div className="spinner">Loading dashboard…</div>;
  }

  const { counts, overdue, upcoming, mailer } = data;

  return (
    <>
      <div className="stat-row">
        <div className="stat accent">
          <div className="label">Companies</div>
          <div className="value">{counts.companies}</div>
        </div>
        <div className="stat">
          <div className="label">Open tasks</div>
          <div className="value">{counts.open_tasks}</div>
        </div>
        <div className={`stat ${counts.overdue ? 'alert' : ''}`}>
          <div className="label">Overdue</div>
          <div className="value">{counts.overdue}</div>
        </div>
      </div>

      <div className="flex-between" style={{ marginBottom: 16 }}>
        <div className="muted">
          Key dates &amp; tasks due in the next 90 days.
        </div>
        <div className="btn-row">
          <span className={`badge ${mailer.enabled ? 'ok' : 'grey'}`}>
            SMTP2GO {mailer.enabled ? 'ready' : 'not configured'}
          </span>
          <button className="btn-navy btn-sm" onClick={sendReminders} disabled={sending}>
            {sending ? 'Sending…' : 'Email me reminders'}
          </button>
        </div>
      </div>

      {msg && <div className="inline-note warn" style={{ marginBottom: 16 }}>{msg}</div>}

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-head">
          <h2>Overdue {overdue.length > 0 && <span className="badge red">{overdue.length}</span>}</h2>
        </div>
        {overdue.length === 0 ? (
          <div className="empty">Nothing overdue. 🎉</div>
        ) : (
          <table>
            <tbody>
              {overdue.map((i) => (
                <ItemRow key={`${i.type}-${i.id}`} item={i} onDismiss={dismiss} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Upcoming</h2>
          <Link to="/companies" className="btn btn-sm">View companies</Link>
        </div>
        {upcoming.length === 0 ? (
          <div className="empty">Nothing due in the next 90 days.</div>
        ) : (
          <table>
            <tbody>
              {upcoming.map((i) => (
                <ItemRow key={`${i.type}-${i.id}`} item={i} onDismiss={dismiss} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
