import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPence, fromPence, percentOfPence, formatPence } from '../src/lib/money.js';
import { csvCell, toCsv } from '../src/lib/csv.js';
import { addDays, monthRange, monthLabel } from '../src/lib/dates.js';
import {
  commissionFor,
  dealFor,
  commissionPence,
  commissionableCeiling,
  reconcileAmounts,
  invoiceTotals,
  invoiceTotalsFromLines,
  commissionNetPence,
  applyExternalState,
  sumCommissionPence,
  commissionInvoiceNumber,
  commissionStatus,
  describeDeal,
  dueDateFor,
  escapeHtml,
  buildCommissionInvoiceEmail,
  matchContractorByName,
  normaliseName,
  contractorSuggestionFrom,
  resolveContractor,
  findDuplicates,
} from '../src/services/commission.js';
import {
  buildInvoicePayload,
  lineFor,
  companyIdFor,
  invoicingStatus,
} from '../src/services/invoicesManager.js';
import { config } from '../src/config.js';
import { regionForAddress } from '../src/services/regions.js';
import {
  canRead,
  stripPersonName,
  spaceAfterNumber,
  stripWorksDate,
  normaliseExtraction,
} from '../src/services/invoiceExtract.js';

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

test('commission on part of an invoice only', () => {
  // £500 net, but only £220 of it was marked up — the rest is materials passed
  // on at cost. The commission is the £20 inside that £220, not the £45.45
  // inside the whole invoice.
  const deal = { commission_type: 'percentage', commission_rate: 10, commission_basis: 'markup' };
  const amounts = { net_amount: 500, vat_amount: 100, total_amount: 600 };
  assert.equal(commissionFor(deal, amounts), 45.45);
  assert.equal(commissionFor(deal, { ...amounts, commissionable_amount: 220 }), 20);
  // Nothing marked up at all is no commission, not the whole invoice's worth.
  assert.equal(commissionFor(deal, { ...amounts, commissionable_amount: 0 }), 0);
  // Null means the whole invoice — the usual case, and every row logged so far.
  assert.equal(commissionFor(deal, { ...amounts, commissionable_amount: null }), 45.45);
});

test('a part bigger than the invoice can only cost the invoice', () => {
  const deal = { commission_type: 'percentage', commission_rate: 10, commission_basis: 'inclusive' };
  // The API refuses this as a typo, but the maths must not invent money if one
  // ever reaches it.
  assert.equal(
    commissionFor(deal, { net_amount: 100, vat_amount: 0, total_amount: 100, commissionable_amount: 400 }),
    10,
  );
});

test('a part caps the commission at the part, not at the invoice', () => {
  // An inclusive deal takes a slice of the part, so an absurd rate can take all
  // of the part — and no more, because the rest of the invoice carries none.
  const deal = { commission_type: 'percentage', commission_rate: 500, commission_basis: 'inclusive' };
  assert.equal(
    commissionFor(deal, { net_amount: 500, total_amount: 500, commissionable_amount: 100 }),
    100,
  );
  // Same for a flat fee agreed on part of a job.
  const fixed = { commission_type: 'fixed', commission_fixed: 250, commission_basis: 'inclusive' };
  assert.equal(
    commissionFor(fixed, { net_amount: 500, total_amount: 500, commissionable_amount: 100 }),
    100,
  );
});

test('the commissionable part is measured against whatever the deal is taken on', () => {
  const amounts = { net_amount: 100, vat_amount: 20, total_amount: 120 };
  assert.equal(commissionableCeiling({ commission_on: 'net' }, amounts), 100);
  assert.equal(commissionableCeiling({ commission_on: 'gross' }, amounts), 120);
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
  assert.equal(payload.lines[0].description, 'Commission - INV-1001, 12 Mill St (Tap repair)');
  assert.equal(payload.lines[0].unitPrice, 10);
  assert.equal(payload.lines[0].quantity, 1);
  assert.match(payload.notes, /2026-08-01/);
});

test('a line still describes itself when the invoice number or works are missing', () => {
  assert.equal(lineFor({ property: '9 Bridge Rd' }).description, 'Commission - 9 Bridge Rd');
  assert.equal(lineFor({ invoice_number: 'INV-7' }).description, 'Commission - INV-7');
  assert.equal(lineFor({}).description, 'Commission - works');
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
  assert.equal(payload.lines[0].description, 'Commission - INV-1');
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

// --- tracing an invoice back to a contractor --------------------------------

const ON_FILE = [
  { id: 'a', name: "Bob's Plumbing Ltd" },
  { id: 'b', name: 'J & J Electrical Limited' },
  { id: 'c', name: 'Mersey Roofing Co' },
];

test('names on invoices match the register through the usual noise', () => {
  for (const printed of [
    "Bob's Plumbing Ltd",
    'BOBS PLUMBING LIMITED',
    'Bobs Plumbing',
    'Bob’s Plumbing Ltd.',
  ]) {
    const m = matchContractorByName(printed, ON_FILE);
    assert.equal(m?.contractor.id, 'a', `"${printed}" should match Bob`);
    assert.equal(m.confident, true);
  }
  // "&" and "and" are the same company.
  assert.equal(matchContractorByName('J and J Electrical', ON_FILE)?.contractor.id, 'b');
  // Company suffixes never decide a match.
  assert.equal(matchContractorByName('Mersey Roofing Limited', ON_FILE)?.contractor.id, 'c');
});

test('a vague or unknown name never auto-fills the wrong contractor', () => {
  // A single generic word must not pick someone and apply their rate.
  for (const vague of ['plumbing', 'roofing', 'Electrical']) {
    const m = matchContractorByName(vague, ON_FILE);
    assert.equal(m?.confident, false, `"${vague}" should only be a suggestion`);
  }
  assert.equal(matchContractorByName('Totally Different Ltd', ON_FILE), null);
  assert.equal(matchContractorByName('', ON_FILE), null);
  assert.equal(matchContractorByName('Bob', []), null);
});

test('normaliseName strips what varies and keeps what identifies', () => {
  assert.equal(normaliseName("Bob's Plumbing Ltd"), 'bobs plumbing');
  assert.equal(normaliseName('J & J Electrical Limited'), 'j and j electrical');
  assert.equal(normaliseName('  The Mersey Roofing Co.  '), 'mersey roofing');
  assert.equal(normaliseName(null), '');
});

test('a new contractor is set up from the invoice, bar the agreement', () => {
  const s = contractorSuggestionFrom(
    {
      contractor_name: 'Davies Gardening Services',
      contractor_address: 'Unit 7, Speke Business Park',
      contractor_email: 'accounts@daviesgardening.co.uk',
      contractor_phone: '0151 555 0142',
    },
    { net_amount: 143, vat_amount: 0, total_amount: 143 },
  );
  assert.equal(s.name, 'Davies Gardening Services');
  assert.equal(s.email, 'accounts@daviesgardening.co.uk');
  // No VAT number and no VAT charged — they aren't registered.
  assert.equal(s.vat_registered, false);
  // The rate is the agreement, and an invoice can't tell us it.
  assert.equal(s.commission_rate, undefined);
});

test('VAT registration is read off the invoice, either way it shows', () => {
  const byNumber = contractorSuggestionFrom(
    { contractor_name: 'X', contractor_vat_number: 'GB 123 4567 89' },
    { vat_amount: 0 },
  );
  assert.equal(byNumber.vat_registered, true);
  const byVatCharged = contractorSuggestionFrom({ contractor_name: 'X' }, { vat_amount: 39.6 });
  assert.equal(byVatCharged.vat_registered, true);
  assert.equal(contractorSuggestionFrom({}, {}), null);
});

// --- tenant names must not ride along on the property address ---------------
// The property goes onto the commission invoice the contractor receives, so a
// tenant's name printed above the address has to come off.

test('a tenant name above the address is stripped', () => {
  const cases = [
    ['Mrs J Smith, 14 Sefton Road, Liverpool L15 2XX', '14 Sefton Road, Liverpool L15 2XX'],
    ['Mr & Mrs Smith, 14 Sefton Road', '14 Sefton Road'],
    ['J Smith, 14 Sefton Road', '14 Sefton Road'],
    ['A.B. Patel, 14 Sefton Road', '14 Sefton Road'],
    ['c/o Mr Jones, 14 Sefton Road', '14 Sefton Road'],
    ['FAO: Sarah Davies\n14 Sefton Road', '14 Sefton Road'],
    ['Attn Mr Smith, 14 Sefton Road', '14 Sefton Road'],
    ['Dr Patel, Flat 2, 30 Park Road', 'Flat 2, 30 Park Road'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(stripPersonName(input), expected, input);
  }
});

test('a real address is never mangled, whatever it starts with', () => {
  // Getting this wrong would be worse than the bug it fixes: these are all
  // addresses, and the first line is the part that identifies the property.
  const untouched = [
    '14 Sefton Road, Liverpool L15 2XX',
    'Rose Cottage, Mill Lane, Wirral',
    'The Old Vicarage, Church Lane',
    'Flat 2, 30 Park Road',
    'Apartment 5, The Quays',
    'Unit 7, Speke Business Park',
    // Block management: "A Block" reads like initials + surname, but the
    // address words give it away.
    'A Block, 12 Main Street',
    'Block A, 12 Main Street',
    'B Court, Sefton Park',
    'St Marys House, Church Lane',
  ];
  for (const address of untouched) {
    assert.equal(stripPersonName(address), address, address);
  }
});

test('an address that is only a name comes back empty, not as the name', () => {
  assert.equal(stripPersonName('Mrs J Smith'), null);
  assert.equal(stripPersonName('c/o Mr Jones'), null);
  assert.equal(stripPersonName(''), '');
  assert.equal(stripPersonName(null), null);
});

test('the extractor applies it to the property it returns', () => {
  const out = normaliseExtraction({ property: 'Mrs J Smith, 14 Sefton Road' });
  assert.equal(out.property, '14 Sefton Road');
});

// --- reacting to the invoicing system ---------------------------------------

test('paid over there becomes paid here, dated when the money arrived', () => {
  const next = applyExternalState(
    { status: 'sent', paid_on: null, external_status: 'sent' },
    { status: 'paid', grandTotal: 10.8, lastPaymentOn: '2026-09-30', paidAt: '2026-10-02T09:00:00Z' },
  );
  assert.equal(next.status, 'paid');
  assert.equal(next.paid_on, '2026-09-30'); // the payment date, not the marking date
  assert.equal(next.changed, true);
});

test('their overdue is still just sent here — chasing happens there', () => {
  const next = applyExternalState({ status: 'sent', external_status: 'sent' }, { status: 'overdue' });
  assert.equal(next.status, 'sent');
  assert.equal(next.external_status, 'overdue');
  assert.equal(next.changed, true); // the external status moved, so it is worth recording
});

test('a voided invoice here is never resurrected from over there', () => {
  const next = applyExternalState({ status: 'void' }, { status: 'paid', grandTotal: 10.8 });
  assert.equal(next.status, 'void');
  assert.equal(next.paid_on, null);
});

test('a payment date corrected over there wins — that is where payments live', () => {
  const next = applyExternalState(
    { status: 'paid', paid_on: '2026-09-15', external_status: 'paid' },
    { status: 'paid', lastPaymentOn: '2026-09-30' },
  );
  assert.equal(next.paid_on, '2026-09-30');
});

test('our date is kept only when they send none at all', () => {
  const next = applyExternalState(
    { status: 'paid', paid_on: '2026-09-15', external_status: 'paid' },
    { status: 'paid' },
  );
  assert.equal(next.paid_on, '2026-09-15');
  assert.equal(next.changed, false); // nothing moved
});

test('unpaying over there clears the paid date here', () => {
  const next = applyExternalState(
    { status: 'paid', paid_on: '2026-09-30', external_status: 'paid' },
    { status: 'sent' },
  );
  assert.equal(next.status, 'sent');
  assert.equal(next.paid_on, null);
});

test('falls back to the marked-paid date when no payment was recorded', () => {
  const next = applyExternalState({ status: 'sent' }, { status: 'paid', paidAt: '2026-10-02T09:00:00Z' });
  assert.equal(next.paid_on, '2026-10-02');
});

test('a missing space after the house number is repaired', () => {
  assert.equal(spaceAfterNumber('15New Cross St'), '15 New Cross St');
  assert.equal(spaceAfterNumber('12Bath Street, Liverpool'), '12 Bath Street, Liverpool');
  // Flat and house letters must survive — "2A" is not "2 A".
  for (const address of ['Flat 2A, 30 Park Road', '14B Sefton Road', 'L1 8JQ', 'Unit 7, L24 9GB']) {
    assert.equal(spaceAfterNumber(address), address, address);
  }
  assert.equal(spaceAfterNumber(null), null);
});

test('the property is cleaned of both the tenant and the missing space', () => {
  assert.equal(
    normaliseExtraction({ property: 'Mrs J Smith, 15New Cross St' }).property,
    '15 New Cross St',
  );
});

// --- who the invoice gets logged against ------------------------------------

const ADS = { id: 'ads', name: 'ADS Maintenance Ltd' };
const BOB = { id: 'bob', name: "Bob's Plumbing" };

test('a contractor already chosen stays chosen, and is not reported as unmatched', () => {
  // The bug this covers: opening the form from a contractor-filtered view
  // pre-selects one, and the form then announced "no contractor on file
  // matches" about an invoice whose contractor was sitting selected.
  const r = resolveContractor({ given: ADS, match: { contractor: ADS, confident: true } });
  assert.equal(r.contractor.id, 'ads');
  assert.equal(r.selected_by, 'given');
  assert.equal(r.mismatch, false);
});

test('a chosen contractor is kept even when the name could not be matched', () => {
  const r = resolveContractor({ given: ADS, match: null });
  assert.equal(r.contractor.id, 'ads');
  assert.equal(r.selected_by, 'given');
  assert.equal(r.mismatch, false);
});

test('an invoice naming someone else than the one selected is flagged', () => {
  const r = resolveContractor({ given: BOB, match: { contractor: ADS, confident: true } });
  assert.equal(r.contractor.id, 'bob'); // the choice stands
  assert.equal(r.mismatch, true); // but it is worth checking
});

test('a low-confidence candidate never overrides or contradicts a choice', () => {
  const r = resolveContractor({ given: BOB, match: { contractor: ADS, confident: false } });
  assert.equal(r.contractor.id, 'bob');
  assert.equal(r.mismatch, false);
});

test('with nothing chosen, only a confident match selects one', () => {
  assert.equal(
    resolveContractor({ match: { contractor: ADS, confident: true } }).selected_by,
    'matched',
  );
  assert.equal(resolveContractor({ match: { contractor: ADS, confident: false } }).contractor, null);
  assert.equal(resolveContractor({}).selected_by, null);
});

test('"ADS Maintenance" on an invoice finds "ADS Maintenance Ltd" on file', () => {
  const m = matchContractorByName('ADS Maintenance', [ADS, BOB]);
  assert.equal(m?.contractor.id, 'ads');
  assert.equal(m.confident, true);
});

// --- "have we had this invoice before?" -------------------------------------

const LOGGED = [
  { id: 'a', invoice_number: 'INV-1042', invoice_date: '2026-08-03', total_amount: '120.00' },
  { id: 'b', invoice_number: null, invoice_date: '2026-08-11', total_amount: '99.00' },
  { id: 'c', invoice_number: '77', invoice_date: '2026-08-11', total_amount: '99.00' },
];

test('the same number is an exact duplicate, compared the way the index compares it', () => {
  const r = findDuplicates({ invoice_number: 'inv-1042' }, LOGGED);
  assert.equal(r.exact?.id, 'a');
  assert.equal(r.similar.length, 0);
});

test('the same number punctuated differently warns but never blocks', () => {
  const r = findDuplicates({ invoice_number: 'INV 1042' }, LOGGED);
  // The index would let this save, so claiming it can't would be a lie.
  assert.equal(r.exact, null);
  assert.deepEqual(r.similar.map((s) => [s.invoice.id, s.reason]), [['a', 'number']]);
});

test('an invoice with no number is matched on the day and the money', () => {
  const r = findDuplicates({ invoice_date: '2026-08-11', total_amount: 99 }, LOGGED);
  assert.equal(r.exact, null);
  // Both of them: with no number to compare, an earlier logging of the same
  // invoice looks exactly like this whether it carried a number or not.
  assert.deepEqual(r.similar.map((s) => s.invoice.id), ['b', 'c']);
});

test('a numbered invoice is still matched against a numberless one on file', () => {
  const r = findDuplicates(
    { invoice_number: 'BOB-9', invoice_date: '2026-08-11', total_amount: '99.00' },
    LOGGED,
  );
  assert.deepEqual(r.similar.map((s) => [s.invoice.id, s.reason]), [['b', 'details']]);
});

test('two invoices that both carry a number are two invoices, alike or not', () => {
  // Same day, same money, different numbers ('c' vs 'BOB-9') — a contractor
  // really can bill the same price twice in a day, and nagging about it would
  // train everyone to click past the warning that matters.
  const r = findDuplicates(
    { invoice_number: 'BOB-9', invoice_date: '2026-08-11', total_amount: '99.00' },
    [LOGGED[2]],
  );
  assert.equal(r.exact, null);
  assert.equal(r.similar.length, 0);
});

test('a different amount on the same day is not a duplicate', () => {
  const r = findDuplicates({ invoice_date: '2026-08-11', total_amount: 99.5 }, LOGGED);
  assert.equal(r.similar.length, 0);
});

test('an invoice being amended is never its own duplicate', () => {
  const r = findDuplicates({ invoice_number: 'INV-1042', exclude_id: 'a' }, LOGGED);
  assert.equal(r.exact, null);
});

test('with nothing to go on, nothing is claimed', () => {
  assert.deepEqual(findDuplicates({}, LOGGED), { exact: null, similar: [] });
  // No amounts typed yet must not match a £0 invoice on file.
  assert.equal(
    findDuplicates({ invoice_date: '2026-08-11' }, [
      { id: 'z', invoice_number: null, invoice_date: '2026-08-11', total_amount: '0.00' },
    ]).similar.length,
    0,
  );
});

// --- which company raises the invoice ---------------------------------------

test('the push goes to the office\'s own company, and says so when one is missing', () => {
  const saved = { ...config.invoicing.companies };
  try {
    config.invoicing.companies.manchester = 2;
    config.invoicing.companies.liverpool = 3;
    assert.equal(companyIdFor('manchester'), 2);
    assert.equal(companyIdFor('liverpool'), 3);
    // Anything unrecognised falls back to Manchester rather than guessing: it
    // is where every invoice went before Liverpool existed.
    assert.equal(companyIdFor(null), 2);

    // An office nobody has linked yet is a settings problem, and the message
    // names the setting instead of letting the other system reject it.
    config.invoicing.companies.liverpool = 0;
    assert.throws(() => companyIdFor('liverpool'), /INVOICING_COMPANY_ID_LIVERPOOL/);
    // ...and it never quietly bills the Manchester company instead.
    assert.throws(() => companyIdFor('liverpool'), /Liverpool/);
  } finally {
    Object.assign(config.invoicing.companies, saved);
  }
});

test('every office reports whether it is linked', () => {
  const saved = { ...config.invoicing.companies };
  try {
    config.invoicing.companies.manchester = 2;
    config.invoicing.companies.liverpool = 0;
    const status = invoicingStatus();
    assert.deepEqual(
      status.companies.map((c) => [c.region, c.linked]),
      [['manchester', true], ['liverpool', false]],
    );
  } finally {
    Object.assign(config.invoicing.companies, saved);
  }
});

// --- the works date on the end of a property address ------------------------

test('the date the work was done comes off the property address', () => {
  // Real invoice (Locksafe Locksmiths INV4628): "Work completed at 11 River
  // View, Birkenhead CH41 ON 15/06/26". The address is copied onto the
  // commission invoice the contractor receives, and "ON" reads as the second
  // half of the postcode — which it cannot be: the last two letters of a UK
  // postcode never include C, I, K, M, O or V.
  assert.equal(
    stripWorksDate('11 River View, Birkenhead CH41 ON 15/06/26'),
    '11 River View, Birkenhead CH41',
  );
  // Whatever survived of it.
  assert.equal(stripWorksDate('11 River View, Birkenhead CH41 ON'), '11 River View, Birkenhead CH41');
  assert.equal(stripWorksDate('11 River View, Birkenhead CH41 15/06/26'), '11 River View, Birkenhead CH41');
  assert.equal(stripWorksDate('14 Sefton Road, L20 9JT, on 15 June 2026'), '14 Sefton Road, L20 9JT');
  assert.equal(stripWorksDate('14 Sefton Road on June 15th'), '14 Sefton Road');
  assert.equal(stripWorksDate('14 Sefton Road on 3.7.2026'), '14 Sefton Road');
});

test('stripping the works date leaves real addresses alone', () => {
  for (const address of [
    '11 River View, Birkenhead CH41 1AA',
    '15 New Cross St, Manchester M4 5AB',
    'Flat 2, 8 Sefton Road, Liverpool, L20 9JT',
    // A month is a perfectly good name for a road or a building.
    '4 June Court, Salford M5 4WT',
    '12 May Street, Liverpool',
    'Unit 3, March Way, Bolton',
    // "on" inside the address, rather than dangling off the end of it.
    '2 Preston on the Hill, Warrington',
    'Newton-le-Willows WA12 8DD',
  ]) {
    assert.equal(stripWorksDate(address), address, address);
  }
  assert.equal(stripWorksDate(null), null);
  assert.equal(stripWorksDate(''), '');
});

test('an invoice reading gets the address and the office, without the date', () => {
  const out = normaliseExtraction({
    invoice_number: 'INV4628',
    invoice_date: '2026-06-18',
    net_amount: 109.45,
    vat_amount: 21.89,
    total_amount: 131.34,
    property: '11 River View, Birkenhead CH41 ON 15/06/26',
    description: 'Changed the lock on the front door.',
    contractor_name: 'Locksafe Locksmiths (NW) Ltd',
  });
  assert.equal(out.property, '11 River View, Birkenhead CH41');
  assert.equal(regionForAddress(out.property).region, 'liverpool');
  // "on the front door" is part of what was done and stays where it is.
  assert.equal(out.description, 'Changed the lock on the front door.');
});

test('a flat-fee invoice keeps its fee when it is amended', () => {
  // The row snapshots the whole agreement. Before migration 015 the flat fee
  // wasn't a column on it, so re-costing an amended invoice read a fee of zero
  // and wiped the commission on every fixed-fee job anyone corrected.
  const contractor = { commission_type: 'fixed', commission_fixed: 15, commission_basis: 'inclusive' };
  const row = {
    commission_type: 'fixed',
    commission_rate: 0,
    commission_fixed: 15,
    commission_on: 'net',
    commission_basis: 'inclusive',
  };
  const snapshot = dealFor(row);
  assert.equal(snapshot.commission_fixed, 15);
  assert.equal(commissionFor({ ...contractor, ...snapshot }, { net_amount: 200, total_amount: 240 }), 15);

  // A fee renegotiated since still doesn't re-rate what was already logged.
  const renegotiated = { ...contractor, commission_fixed: 25 };
  assert.equal(
    commissionFor({ ...renegotiated, ...snapshot }, { net_amount: 200, total_amount: 240 }),
    15,
  );
});

test('canRead takes the file types an invoice actually arrives as', () => {
  assert.equal(canRead('application/pdf', 'invoice.pdf'), true);
  assert.equal(
    canRead('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'inv.docx'),
    true,
  );
  assert.equal(canRead('application/octet-stream', 'inv.docx'), true);
  assert.equal(canRead('image/jpeg', 'photo.jpg'), true);
  assert.equal(canRead('text/plain', 'invoice.txt'), true);
  // The old binary .doc can't be read — the caller says so in as many words
  // rather than sending Word's internal soup to the model.
  assert.equal(canRead('application/msword', 'invoice.doc'), false);
  assert.equal(canRead('application/zip', 'invoices.zip'), false);
});
