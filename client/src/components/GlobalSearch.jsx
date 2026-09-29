import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

// The search box in the top bar: an account number, a reference (theirs, or
// our GC-C- / GC-CI- / GC-COM- codes), a company number, a name or an address,
// and straight to the record. Only sections the person may see are searched
// (the server decides). Enter opens the first result; arrows move; Esc closes.
export default function GlobalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  // The words the results on screen are for: until they match what is typed,
  // Enter waits (it would open a result for the shorter search).
  const [resultsFor, setResultsFor] = useState(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef(null);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults(null); setResultsFor(null); return undefined; }
    const n = ++seq.current;
    const t = setTimeout(() => {
      api.search(term)
        .then((r) => { if (n === seq.current) { setResults(r.results); setResultsFor(term); setFailed(false); setActive(0); } })
        .catch(() => { if (n === seq.current) { setResults([]); setResultsFor(term); setFailed(true); } });
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  // A click anywhere else closes the list.
  useEffect(() => {
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const go = (r) => {
    if (!r) return;
    setOpen(false);
    setQ('');
    setResults(null);
    navigate(r.url);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { setOpen(false); e.currentTarget.blur(); return; }
    const current = resultsFor === q.trim();
    if (e.key === 'Enter') e.preventDefault();
    if (!current || !results?.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    if (e.key === 'Enter') go(results[active]);
  };

  return (
    <div className="global-search" ref={box}>
      <input
        type="search"
        value={q}
        placeholder="Search account no., reference, name…"
        aria-label="Search everything"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {open && q.trim().length >= 2 && (
        <div className="global-search-results" role="listbox">
          {results === null || resultsFor !== q.trim() ? (
            <div className="muted" style={{ padding: 12, fontSize: 13 }}>Searching…</div>
          ) : failed ? (
            <div className="muted" style={{ padding: 12, fontSize: 13 }}>The search didn’t work just now. Try again in a moment.</div>
          ) : results.length === 0 ? (
            <div className="muted" style={{ padding: 12, fontSize: 13 }}>Nothing found for “{q.trim()}”.</div>
          ) : results.map((r, i) => (
            <div
              key={`${r.kind}-${r.id}`}
              role="option"
              aria-selected={i === active}
              className={`gs-row ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); go(r); }}
            >
              <span className="gs-kind">{r.kind}</span>
              <span className="gs-title">{r.title}</span>
              {r.detail && <span className="gs-detail">{r.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
