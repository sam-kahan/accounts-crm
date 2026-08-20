import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPence, fromPence, percentOfPence, formatPence } from '../src/lib/money.js';
import { csvCell, toCsv } from '../src/lib/csv.js';
import { addDays, monthRange, monthLabel } from '../src/lib/dates.js';
import {
  commissionFor,
  commissionPence,
  reconcileAmounts,
  invoiceTotals,
  invoiceTotalsFromLines,
  commissionNetPence,
  sumCommissionPence,
  commissionInvoiceNumber,
  commissionStatus,
  describeDeal,
  dueDateFor,
  escapeHtml,
  buildCommissionInvoiceEmail,
} from '../src/services/commission.js';
import { buildInvoicePayload, lineFor } from '../src/services/invoicesManager.js';

// --- money -----------------------------------------------------------------

test('toPence parses numbers, pg NUMERIC strings and blanks', () => {
  assert.equal(toPence(100), 10000);
  assert.equal(toPence('100.00'), 10000);   // how pg hands back NUMERIC
  assert.equal(toPence(' 12.34 '), 1234);
  assert.equal(toPence(0), 0);
  assert.equal(toPence(''), null);
  assert.equal(toPence(null), null);
  assert.equal(toPence(undefined), null);
  assert.equal(toPence('not a number'), null);
});

test('toPence rounds half away from zero, the way money rounds', () => {
  assert.equal(toPence(0.005), 1);
  assert.equal(toPence(-0.005), -1);
  assert.equal(toPence(1.005), 101); // the classic float case: 1.005*100 = 100.49999
});

test('fromPence returns a 2dp number', () => {
  assert.equal(fromPence(1050), 10.5);
  assert.equal(fromPence(0), 0);
  assert.equal(fromPence(null), null);
});

test('percentOfPence stays exact where floats would drift', () => {
  assert.equal(percentOfPence(10000, 10), 1000);      // 10% of £100 = £10
  assert.equal(percentOfPence(2345, 12.375), 290);    // 3-dp rates supported
  assert.equal(percentOfPence(10000, 0), 0);
  // 10% of £8.15 is 81.5p — rounds up, not down to 81 as binary maths gives.
  assert.equal(percentOfPence(815, 10), 82);
});

test('formatPence renders UK money with thousands separators', () => {
  assert.equal(formatPence(1000), '£10.00');
  assert.equal(formatPence(123456789), '£1,234,567.89');
  assert.equal(formatPence(5), '£0.05');
  assert.equal(formatPence(-1050), '-£10.50');
});

// --- the commission calculation --------------------------------------------

test('the real deal: their £90 price + 10% is invoiced at £99, and £9 is ours', () => {
  // The percentage is a mark-up on the CONTRACTOR's price, not a slice of the
  // invoice: 10% of the £99 invoice would be £9.90 and over-claim every job.
  const deal = { commission_type: 'percentage', commission_rate: 10, commission_basis: 'markup' };
  assert.equal(commissionFor(deal, { net_amount: 99, vat_amount: 19.8, total_amount: 118.8 }), 9);
  assert.equal(commissionFor(deal, { net_amount: 275, total_amount: 275 }), 25); // £250 + 10%
  assert.equal(commissionFor(deal, { net_amount: 0, total_amount: 0 }), 0);
});

test('mark-up is the default basis — an unstated deal is not read as a slice', () => {
  const deal = { commission_type: 'percentage', commission_rate: 10 };
  assert.equal(commissionFor(deal, { net_amount: 99, total_amount: 99 }), 9);
});

test('mark-up on the gross, when that is how it was agreed', () => {
  const deal = {
    commission_type: 'percentage',
    commission_rate: 10,
    commission_basis: 'markup',
    commission_on: 'gross',
  };
  // £118.80 gross carries £10.80 of commission (£108 + 10%).
  assert.equal(commissionFor(deal, { net_amount: 99, vat_amount: 19.8, total_amount: 118.8 }), 10.8);
});

test('mark-up rounds to the penny and stays exact at odd rates', () => {
  const deal = { commission_type: 'percentage', commission_rate: 12.5, commission_basis: 'markup' };
  // £80 + 12.5% = £90; the commission inside £90 is £10.
  assert.equal(commissionFor(deal, { net_amount: 90, total_amount: 90 }), 10);
  // £137.55 -> 137.55 * 12.5 / 112.5 = 15.283... -> 15.28
  assert.equal(commissionFor(deal, { net_amount: 137.55, total_amount: 137.55 }), 15.28);
});

test('a mark-up commission can never swallow the whole invoice', () => {
  const deal = { commission_type: 'percentage', commission_rate: 500, commission_basis: 'markup' };
  // Even at an absurd rate it stays below the invoice: 100 * 500/600 = 83.33.
  assert.equal(commissionFor(deal, { net_amount: 100, total_amount: 100 }), 83.33);
});

test('a slice-of-the-invoice deal still works, for contractors worded that way', () => {
  const deal = { commission_type: 'percentage', commission_rate: 10, commission_basis: 'inclusive' };
  assert.equal(commissionFor(deal, { net_amount: 100, vat_amount: 0, total_amount: 100 }), 10);
  assert.equal(commissionFor(deal, { net_amount: 99, total_amount: 99 }), 9.9);
});

test('percentage commission is taken on the net by default, gross on request', () => {
  const amounts = { net_amount: 100, vat_amount: 20, total_amount: 120 };
  const deal = { commission_type: 'percentage', commission_rate: 10, commission_basis: 'inclusive' };
  assert.equal(commissionFor(deal, amounts), 10);
  assert.equal(commissionFor({ ...deal, commission_on: 'gross' }, amounts), 12);
});

test('a fixed-fee agreement ignores the rate', () => {
  const deal = { commission_type: 'fixed', commission_fixed: 15, commission_rate: 99 };
  assert.equal(commissionFor(deal, { net_amount: 240, vat_amount: 0, total_amount: 240 }), 15);
});

test('an inclusive commission can never exceed the invoice it came out of', () => {
  // A mis-keyed 500% rate must not produce a claim for more than we paid.
  const deal = { commission_type: 'percentage', commission_rate: 500, commission_basis: 'inclusive' };
  assert.equal(commissionFor(deal, { net_amount: 100, vat_amount: 0, total_amount: 100 }), 100);
  // ...but an on-top commission is charged in addition, so it isn't capped.
  assert.equal(
    commissionFor({ ...deal, commission_basis: 'on_top' }, { net_amount: 100, total_amount: 100 }),
    500,
  );
});

test('a missing or malformed deal falls back to zero commission, not NaN', () => {
  assert.equal(commissionFor({}, { net_amount: 100, total_amount: 100 }), 0);
  assert.equal(
    commissionFor({ commission_type: 'nonsense', commission_rate: null }, { net_amount: 100 }),
    0,
  );
});

test('negative amounts never yield a negative claim', () => {
  for (const commission_basis of ['markup', 'inclusive', 'on_top']) {
    const deal = { commission_type: 'percentage', commission_rate: 10, commission_basis };
    assert.equal(commissionPence(deal, { netPence: -10000, totalPence: -10000 }), 0);
  }
});

test('rounding is per invoice, so a month of odd amounts stays exact', () => {
  const deal = { commission_type: 'percentage', commission_rate: 10, commission_basis: 'inclusive' };
  const invoices = [8.15, 8.15, 8.15].map((net) => ({
    commission_amount: commissionFor(deal, { net_amount: net, total_amount: net }),
  }));
  // 81.5p each, rounded up to 82p, three times.
  assert.equal(sumCommissionPence(invoices), 246);
});

// --- amount reconciliation --------------------------------------------------

test('reconcileAmounts fills in whichever amount is missing', () => {
  assert.deepEqual(reconcileAmounts({ net_amount: 100, vat_amount: 20 }), {
    net_amount: 100,
    vat_amount: 20,
    total_amount: 120,
  });
  assert.deepEqual(reconcileAmounts({ total_amount: 120, vat_amount: 20 }), {
    net_amount: 100,
    vat_amount: 20,
    total_amount: 120,
  });
});

test('a lone total with no VAT reads as a non-VAT invoice', () => {
  assert.deepEqual(reconcileAmounts({ total_amount: 100 }), {
    net_amount: 100,
    vat_amount: 0,
    total_amount: 100,
  });
});

test('reconcileAmounts derives VAT from the gap and never goes negative', () => {
  assert.deepEqual(reconcileAmounts({ net_amount: 100, total_amount: 120 }), {
    net_amount: 100,
    vat_amount: 20,
    total_amount: 120,
  });
  assert.deepEqual(reconcileAmounts({ net_amount: 120, total_amount: 100 }), {
    net_amount: 120,
    vat_amount: 0,
    total_amount: 100,
  });
  assert.deepEqual(reconcileAmounts({}), { net_amount: 0, vat_amount: 0, total_amount: 0 });
});

// --- the invoice we raise ---------------------------------------------------

test('invoiceTotals adds VAT to the commission total', () => {
  assert.deepEqual(invoiceTotals(100, 20), {
    net_amount: 100,
    vat_rate: 20,
    vat_amount: 20,
    total_amount: 120,
  });
});

test('with no VAT rate the total is just the commission', () => {
  assert.deepEqual(invoiceTotals(37.5, 0), {
    net_amount: 37.5,
    vat_rate: 0,
    vat_amount: 0,
    total_amount: 37.5,
  });
});

test('invoice numbers are zero-padded and sequential', () => {
  assert.equal(commissionInvoiceNumber(1), 'GC-COM-00001');
  assert.equal(commissionInvoiceNumber(4213), 'GC-COM-04213');
  assert.equal(commissionInvoiceNumber(1, 'GRN-'), 'GRN-00001');
});

test('commissionStatus is derived from the link, not stored separately', () => {
  assert.equal(commissionStatus({}), 'pending');
  assert.equal(commissionStatus({ waived: true }), 'waived');
  assert.equal(commissionStatus({ commission_invoice_id: 'x', commission_invoice_status: 'sent' }), 'invoiced');
  assert.equal(commissionStatus({ commission_invoice_id: 'x', commission_invoice_status: 'draft' }), 'invoiced');
  assert.equal(commissionStatus({ commission_invoice_id: 'x', commission_invoice_status: 'paid' }), 'paid');
  // A waived item is never billed, so waived wins over any stale link.
  assert.equal(commissionStatus({ waived: true, commission_invoice_id: 'x' }), 'waived');
});

test('describeDeal reads as the agreement in words', () => {
  assert.equal(
    describeDeal({ commission_type: 'percentage', commission_rate: 10 }),
    'their price + 10%, included in their invoice',
  );
  assert.equal(
    describeDeal({ commission_type: 'percentage', commission_rate: 10, commission_basis: 'inclusive' }),
    '10% of the invoice net, included in their invoice',
  );
  assert.equal(
    describeDeal({ commission_type: 'fixed', commission_fixed: 15, commission_basis: 'on_top' }),
    '£15.00 per invoice, charged on top',
  );
});

test('dueDateFor applies payment terms in calendar days', () => {
  assert.equal(dueDateFor('2026-08-31', 30), '2026-09-30');
  assert.equal(dueDateFor('2026-08-31', 0), '2026-08-31');
  assert.equal(dueDateFor('2026-08-31', undefined), '2026-09-30'); // 30-day default
});

// --- dates ------------------------------------------------------------------

test('addDays crosses months, years and the BST boundary safely', () => {
  assert.equal(addDays('2026-08-20', 1), '2026-08-21');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-10-24', 7), '2026-10-31'); // clocks go back mid-window
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('monthRange covers the whole month, leap years included', () => {
  assert.deepEqual(monthRange('2026-08'), { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(monthRange('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  assert.equal(monthRange('nonsense'), null);
  assert.equal(monthRange('2026-13'), null);
});

test('monthLabel reads as a month name', () => {
  assert.equal(monthLabel('2026-08'), 'August 2026');
});

// --- CSV --------------------------------------------------------------------

test('csvCell quotes commas, quotes and newlines', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(0), '0');
});

test('csvCell defuses spreadsheet formulas in supplier-supplied text', () => {
  // Invoice numbers and descriptions come from contractors (and from a PDF read
  // by the extractor) — Excel would otherwise run these on open.
  assert.equal(csvCell('=cmd|calc'), "'=cmd|calc");
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-lookup'), "'-lookup");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
});

test('toCsv writes a header row and CRLF line endings', () => {
  const csv = toCsv(
    [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }],
    [{ a: 1, b: 'two' }],
    { bom: false },
  );
  assert.equal(csv, 'Alpha,Beta\r\n1,two\r\n');
});

// --- the outgoing invoice email ---------------------------------------------

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  assert.equal(escapeHtml(null), '');
});

test('the commission invoice email lists every line and totals them', () => {
  const mail = buildCommissionInvoiceEmail({
    invoice: {
      invoice_number: 'GC-COM-00007',
      period_start: '2026-08-01',
      period_end: '2026-08-31',
      issue_date: '2026-09-01',
      due_date: '2026-10-01',
      net_amount: 30,
      vat_rate: 20,
      vat_amount: 6,
      total_amount: 36,
      notes: null,
    },
    contractor: { name: "Bob's Plumbing" },
    lines: [
      { invoice_date: '2026-08-04', invoice_number: 'INV-1', property: '12 Mill St', total_amount: 100, commission_amount: 10 },
      { invoice_date: '2026-08-19', invoice_number: 'INV-2', property: '9 Bridge Rd', total_amount: 200, commission_amount: 20 },
    ],
    billing: { name: 'Greenco', bank_details: 'Sort 00-00-00\nAcc 12345678' },
  });

  assert.match(mail.subject, /GC-COM-00007/);
  assert.match(mail.subject, /August 2026/);
  assert.match(mail.text, /INV-1/);
  assert.match(mail.text, /INV-2/);
  assert.match(mail.text, /£30\.00/);   // commission total
  assert.match(mail.text, /£36\.00/);   // gross due
  assert.match(mail.html, /12 Mill St/);
  assert.match(mail.html, /Sort 00-00-00/);
});

test('contractor-supplied text is escaped in the invoice email', () => {
  const mail = buildCommissionInvoiceEmail({
    invoice: {
      invoice_number: 'GC-COM-00008', period_start: '2026-08-01', period_end: '2026-08-31',
      issue_date: '2026-09-01', due_date: '2026-10-01',
      net_amount: 10, vat_rate: 0, vat_amount: 0, total_amount: 10,
    },
    contractor: { name: '<b>Bob</b>' },
    lines: [
      { invoice_date: '2026-08-04', invoice_number: '<img src=x onerror=alert(1)>', property: 'A & B', total_amount: 100, commission_amount: 10 },
    ],
    billing: { name: 'Greenco' },
  });
  assert.ok(!mail.html.includes('<img src=x'));
  assert.match(mail.html, /&lt;img src=x/);
  assert.match(mail.html, /A &amp; B/);
  assert.ok(!mail.html.includes('<b>Bob</b>'));
});

test('a zero-VAT invoice email omits the VAT line entirely', () => {
  const mail = buildCommissionInvoiceEmail({
    invoice: {
      invoice_number: 'GC-COM-00009', period_start: '2026-08-01', period_end: '2026-08-31',
      issue_date: '2026-09-01', due_date: '2026-10-01',
      net_amount: 10, vat_rate: 0, vat_amount: 0, total_amount: 10,
    },
    contractor: { name: 'Bob' },
    lines: [{ invoice_date: '2026-08-04', invoice_number: 'INV-1', total_amount: 100, commission_amount: 10 }],
    billing: {},
  });
  assert.ok(!mail.text.includes('VAT'));
  assert.ok(!mail.html.includes('VAT ('));
});

// --- per-line VAT (matching the invoicing system) ---------------------------

test('invoiceTotalsFromLines rounds VAT per line, as an invoice does', () => {
  const lines = [
    { commission_amount: 10.33 },
    { commission_amount: 10.33 },
    { commission_amount: 10.33 },
  ];
  // Per line: 2.066 -> 2.07, three times = 6.21. Rounding the sum instead
  // (30.99 * 20% = 6.198 -> 6.20) is a penny out — and a penny of daylight
  // between this and Greenco Invoicing is a query nobody wants.
  assert.deepEqual(invoiceTotalsFromLines(lines, 20), {
    net_amount: 30.99,
    vat_rate: 20,
    vat_amount: 6.21,
    total_amount: 37.2,
  });
});

test('invoiceTotalsFromLines handles no VAT and no lines', () => {
  assert.deepEqual(invoiceTotalsFromLines([{ commission_amount: 30 }], 0), {
    net_amount: 30,
    vat_rate: 0,
    vat_amount: 0,
    total_amount: 30,
  });
  assert.deepEqual(invoiceTotalsFromLines([], 20), {
    net_amount: 0,
    vat_rate: 20,
    vat_amount: 0,
    total_amount: 0,
  });
});

// --- the push to Greenco Invoicing ------------------------------------------

const PUSH_INVOICE = {
  invoice_number: 'GC-COM-00001',
  issue_date: '2026-09-01',
  due_date: '2026-10-01',
  period_start: '2026-08-01',
  period_end: '2026-08-31',
  vat_rate: 0,
  notes: null,
};
const PUSH_CONTRACTOR = { name: "Bob's Plumbing", email: 'bob@example.com' };

test('a pushed invoice carries one line per contractor invoice', () => {
  const payload = buildInvoicePayload({
    invoice: PUSH_INVOICE,
    contractor: PUSH_CONTRACTOR,
    lines: [
      { invoice_number: 'INV-1001', property: '12 Mill St', description: 'Tap repair', commission_amount: 10 },
      { invoice_number: 'INV-1002', property: '9 Bridge Rd', description: 'Boiler service', commission_amount: 20 },
    ],
    companyId: 1,
    asSent: false,
  });

  assert.equal(payload.companyId, 1);
  // Our reference is what reconciles the two systems — and their idempotency key.
  assert.equal(payload.reference, 'GC-COM-00001');
  assert.equal(payload.client.name, "Bob's Plumbing");
  assert.equal(payload.status, 'draft');
  assert.equal(payload.lines.length, 2);
  assert.equal(payload.lines[0].description, 'Commission — INV-1001, 12 Mill St (Tap repair)');
  assert.equal(payload.lines[0].unitPrice, 10);
  assert.equal(payload.lines[0].quantity, 1);
  assert.match(payload.notes, /2026-08-01/);
});

test('a line still describes itself when the invoice number or works are missing', () => {
  assert.equal(lineFor({ property: '9 Bridge Rd' }).description, 'Commission — 9 Bridge Rd');
  assert.equal(lineFor({ invoice_number: 'INV-7' }).description, 'Commission — INV-7');
  assert.equal(lineFor({}).description, 'Commission — works');
});

test('zero-commission lines are left off the invoice', () => {
  const payload = buildInvoicePayload({
    invoice: PUSH_INVOICE,
    contractor: PUSH_CONTRACTOR,
    lines: [
      { invoice_number: 'INV-1', commission_amount: 10 },
      { invoice_number: 'INV-2', commission_amount: 0 },
    ],
    companyId: 1,
  });
  assert.equal(payload.lines.length, 1);
  assert.equal(payload.lines[0].description, 'Commission — INV-1');
});

test('an invoice with nothing billable is refused rather than sent empty', () => {
  assert.throws(
    () =>
      buildInvoicePayload({
        invoice: PUSH_INVOICE,
        contractor: PUSH_CONTRACTOR,
        lines: [{ invoice_number: 'INV-1', commission_amount: 0 }],
        companyId: 1,
      }),
    /no billable lines/,
  );
});

test('a VAT rate the invoicing system cannot take is caught here, with a fix', () => {
  assert.throws(
    () =>
      buildInvoicePayload({
        invoice: { ...PUSH_INVOICE, vat_rate: 17.5 },
        contractor: PUSH_CONTRACTOR,
        lines: [{ invoice_number: 'INV-1', commission_amount: 10 }],
        companyId: 1,
      }),
    /only accepts VAT at/,
  );
  // The rates it does take go through, and land on every line.
  for (const vat_rate of [0, 5, 20]) {
    const p = buildInvoicePayload({
      invoice: { ...PUSH_INVOICE, vat_rate },
      contractor: PUSH_CONTRACTOR,
      lines: [{ invoice_number: 'INV-1', commission_amount: 10 }],
      companyId: 1,
    });
    assert.equal(p.lines[0].vatRate, vat_rate);
  }
});

test('asSent controls whether it arrives as a draft or already sent', () => {
  const base = {
    invoice: PUSH_INVOICE,
    contractor: PUSH_CONTRACTOR,
    lines: [{ invoice_number: 'INV-1', commission_amount: 10 }],
    companyId: 1,
  };
  assert.equal(buildInvoicePayload({ ...base, asSent: true }).status, 'sent');
  assert.equal(buildInvoicePayload({ ...base, asSent: false }).status, 'draft');
});

// --- VAT: the contractor's registration status ------------------------------

test('a VAT-registered contractor: the £9 collected is the net, VAT on top', () => {
  // Their own invoice carried the VAT, so they collected £9 + £1.80 alongside it.
  assert.deepEqual(invoiceTotalsFromLines([{ commission_amount: 9 }], 20), {
    net_amount: 9,
    vat_rate: 20,
    vat_amount: 1.8,
    total_amount: 10.8,
  });
});

test('a contractor who is not VAT registered: the £9 collected is the gross', () => {
  // They invoiced £99 flat and only ever took £9, so we net it down and they
  // pay back exactly what they collected.
  assert.deepEqual(
    invoiceTotalsFromLines([{ commission_amount: 9, commission_vat_inclusive: true }], 20),
    { net_amount: 7.5, vat_rate: 20, vat_amount: 1.5, total_amount: 9 },
  );
});

test('the netted-down total comes back to what was collected', () => {
  // Greenco Invoicing recomputes VAT from the net we send it, so the net has to
  // be one that adds back up — otherwise the contractor's copy disagrees.
  for (const collected of [9, 12.5, 20, 33.33, 100, 250.75, 1234.56]) {
    const t = invoiceTotalsFromLines(
      [{ commission_amount: collected, commission_vat_inclusive: true }],
      20,
    );
    assert.equal(t.net_amount + t.vat_amount, t.total_amount);
    assert.ok(
      Math.abs(t.total_amount - collected) <= 0.01,
      `£${collected} collected -> £${t.total_amount} due`,
    );
    // The VAT is exactly what the invoicing system will work out from the net.
    assert.equal(t.vat_amount, Math.round(t.net_amount * 20) / 100);
  }
});

test('with no VAT rate the status makes no difference', () => {
  assert.deepEqual(
    invoiceTotalsFromLines([{ commission_amount: 9, commission_vat_inclusive: true }], 0),
    { net_amount: 9, vat_rate: 0, vat_amount: 0, total_amount: 9 },
  );
});

test('commissionNetPence leaves a registered contractor’s figure alone', () => {
  assert.equal(commissionNetPence({ commission_amount: 9 }, 20), 900);
  assert.equal(commissionNetPence({ commission_amount: 9, commission_vat_inclusive: true }, 20), 750);
  assert.equal(commissionNetPence({ commission_amount: 0, commission_vat_inclusive: true }, 20), 0);
});

test('a month mixing both kinds of line totals correctly', () => {
  const t = invoiceTotalsFromLines(
    [
      { commission_amount: 9 },                                   // registered: net
      { commission_amount: 9, commission_vat_inclusive: true },    // not: gross
    ],
    20,
  );
  assert.deepEqual(t, { net_amount: 16.5, vat_rate: 20, vat_amount: 3.3, total_amount: 19.8 });
});

test('the push sends the NET commission, so their gross matches what was collected', () => {
  const invoice = {
    invoice_number: 'GC-COM-00001', issue_date: '2026-09-01', due_date: '2026-10-01',
    period_start: '2026-08-01', period_end: '2026-08-31', vat_rate: 20,
  };
  const payload = buildInvoicePayload({
    invoice,
    contractor: { name: 'Bob' },
    lines: [{ invoice_number: 'A', commission_amount: 9, commission_vat_inclusive: true }],
    companyId: 1,
  });
  assert.equal(payload.lines[0].unitPrice, 7.5);
  assert.equal(payload.lines[0].vatRate, 20);
});
