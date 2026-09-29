import { useEffect, useState } from 'react';
import { api, todayISO } from '../api';

// Admin → AI usage. What the AI has cost this month, which features used it,
// and each month for the last year, so the bill is never a surprise. Figures
// are estimates from Anthropic's list prices, in US dollars (how Anthropic
// bills); their invoice is the authority.
const dollars = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const count = (n) => (Number(n) || 0).toLocaleString('en-GB');
const monthName = (ym) => new Date(`${ym}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

export default function AiUsage() {
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = () => {
    setError(null);
    api.aiUsage(month).then(setData).catch((e) => setError(e.message));
  };
  useEffect(() => { setData(null); load(); }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="card"><div className="card-body">
        <div className="inline-note warn" style={{ marginBottom: 10 }}>{error}</div>
        <button className="btn-primary btn-sm" onClick={load}>Retry</button>
      </div></div>
    );
  }
  if (!data) return <div className="spinner">Loading…</div>;

  const t = data.total;
  const thisMonth = todayISO().slice(0, 7);
  // A month still running: where it is heading at this rate.
  let projected = null;
  if (month === thisMonth && t.dollars > 0) {
    const [y, m] = month.split('-').map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const day = Number(todayISO().slice(8, 10));
    projected = (t.dollars / day) * days;
  }
  const months = data.by_month.length ? data.by_month : [];

  return (
    <>
      <div className="toolbar flex-between">
        <div className="btn-row">
          <input type="month" value={month} max={thisMonth} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Month" />
        </div>
        <span className="muted" style={{ fontSize: 13 }}>Model: <code>{data.model}</code></span>
      </div>

      <div className="stat-row" style={{ marginBottom: 20 }}>
        <div className="stat">
          <div className="label">{monthName(month)}</div>
          <div className="value">{dollars(t.dollars)}</div>
          {projected !== null && <div className="muted" style={{ fontSize: 12 }}>about {dollars(projected)} by the month end at this rate</div>}
        </div>
        <div className="stat">
          <div className="label">AI calls</div>
          <div className="value">{count(t.calls)}</div>
          <div className="muted" style={{ fontSize: 12 }}>{t.calls ? `${dollars(t.dollars / t.calls)} each on average` : 'none yet'}</div>
        </div>
        <div className="stat">
          <div className="label">Words read / written</div>
          <div className="value" style={{ fontSize: 20 }}>{count(t.input_tokens)} / {count(t.output_tokens)}</div>
          <div className="muted" style={{ fontSize: 12 }}>tokens in / out{t.web_searches ? ` · ${count(t.web_searches)} web searches` : ''}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-head"><h2>What it was spent on</h2></div>
        {data.by_feature.length === 0 ? (
          <div className="empty">No AI calls recorded in {monthName(month)}.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Feature</th><th className="num">Calls</th><th className="num">Tokens in</th><th className="num">Tokens out</th><th className="num">Cost</th><th className="num">Share</th></tr>
            </thead>
            <tbody>
              {data.by_feature.map((f) => (
                <tr key={f.key}>
                  <td><strong>{f.key}</strong>{f.unpriced && <div className="muted" style={{ fontSize: 11 }}>includes a model with no price on file</div>}</td>
                  <td className="num">{count(f.calls)}</td>
                  <td className="num">{count(f.input_tokens)}</td>
                  <td className="num">{count(f.output_tokens)}</td>
                  <td className="num"><strong>{dollars(f.dollars)}</strong></td>
                  <td className="num">{t.dollars ? `${Math.round((f.dollars / t.dollars) * 100)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data.by_day.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-head"><h2>Day by day</h2></div>
          <table>
            <thead><tr><th>Day</th><th className="num">Calls</th><th className="num">Cost</th></tr></thead>
            <tbody>
              {data.by_day.map((d) => (
                <tr key={d.key}><td>{dayName(d.key)}</td><td className="num">{count(d.calls)}</td><td className="num">{dollars(d.dollars)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {months.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-head"><h2>Month by month</h2></div>
          <table>
            <thead><tr><th>Month</th><th className="num">Calls</th><th className="num">Cost</th></tr></thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.key} className="clickable" onClick={() => setMonth(m.key)}>
                  <td>{monthName(m.key)}{m.key === month ? ' (shown)' : ''}</td><td className="num">{count(m.calls)}</td><td className="num">{dollars(m.dollars)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="muted" style={{ fontSize: 12 }}>
        Estimates from Anthropic&rsquo;s list prices in US dollars, which is how Anthropic bills; their invoice is
        the final word. Recorded from 29 September 2026, when this page was added, so earlier months show nothing.
        Every AI call the system makes is counted here, whether a person asked for it or it ran by itself.
      </p>
    </>
  );
}
