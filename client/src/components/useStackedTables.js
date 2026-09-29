import { useEffect } from 'react';

// On a phone a wide table either squeezes to nothing or hides its right-hand
// columns (the money, usually) off the edge. index.css turns each row into a
// card instead, and that needs every cell to know its column's name: this
// copies each table's headings onto its cells as data-label, and keeps doing
// so as rows load or change. A table marked .no-stack is left alone.
function labelTable(table) {
  if (table.classList.contains('no-stack')) return;
  const heads = [...table.querySelectorAll(':scope > thead > tr:last-child > th')];
  // Only a table with headings becomes cards; one without has nothing to
  // label its values with, so it keeps its own layout.
  if (!heads.length) return;
  table.classList.add('stacked');
  const names = [];
  for (const th of heads) {
    const span = Number(th.getAttribute('colspan')) || 1;
    // A sort arrow (or anything else marked aria-hidden) isn't part of its name.
    const copy = th.cloneNode(true);
    copy.querySelectorAll('[aria-hidden="true"]').forEach((el) => el.remove());
    const name = (copy.textContent || '').replace(/[↑↓↕▲▼⇅]/g, '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < span; i += 1) names.push(name);
  }
  for (const tr of table.querySelectorAll(':scope > tbody > tr, :scope > tfoot > tr')) {
    let col = 0;
    for (const td of tr.children) {
      const span = Number(td.getAttribute('colspan')) || 1;
      const label = span > 1 ? '' : names[col] || '';
      if (td.getAttribute('data-label') !== label) td.setAttribute('data-label', label);
      col += span;
    }
  }
}

export function useStackedTables(root = typeof document !== 'undefined' ? document.body : null) {
  useEffect(() => {
    if (!root || typeof MutationObserver === 'undefined') return undefined;
    let queued = false;
    const run = () => {
      queued = false;
      root.querySelectorAll('table').forEach(labelTable);
    };
    run();
    const obs = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(run);
    });
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    return () => obs.disconnect();
  }, [root]);
}
