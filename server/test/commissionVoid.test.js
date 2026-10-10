import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentRecorded } from '../src/services/commissionVoid.js';

// The shape GET /api/external/invoices/:id returns in Greenco Invoicing
// (v2/src/app/api/external/invoices/[id]/route.ts).
const state = (over) => ({ status: 'sent', paidTotal: 0, outstanding: 10.8, paidAt: null, lastPaymentOn: null, ...over });

test('paymentRecorded reads what Greenco Invoicing sends', () => {
  assert.equal(paymentRecorded(state()), false);
  assert.equal(paymentRecorded(state({ status: 'overdue' })), false);
  assert.equal(paymentRecorded(state({ status: 'cancelled', outstanding: 0 })), false);
  assert.equal(paymentRecorded(state({ status: 'paid', paidTotal: 10.8, outstanding: 0, paidAt: '2026-10-01T10:00:00Z', lastPaymentOn: '2026-10-01' })), true);
  // A part-payment leaves the status at sent/overdue: the amount and date say it.
  assert.equal(paymentRecorded(state({ status: 'overdue', paidTotal: 5, outstanding: 5.8, lastPaymentOn: '2026-10-02' })), true);
  assert.equal(paymentRecorded(state({ paidTotal: 5 })), true);
  assert.equal(paymentRecorded(null), false);
});
