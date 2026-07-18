import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchEmailToComplaint } from '../src/services/emailIngest.js';

const index = [
  {
    id: 'c1',
    ref_code: 'GC-C-ABC234',
    email_address: 'complaint-abc234@greenco.co.uk',
  },
  {
    id: 'c2',
    ref_code: 'GC-C-XYZ789',
    email_address: 'complaint-xyz789@greenco.co.uk',
  },
];

test('matches on the complaint catch-all address in the recipients', () => {
  const m = matchEmailToComplaint(
    {
      subject: 'Re: your enquiry',
      bodyPreview: 'no reference here',
      toAddresses: ['someone@council.gov.uk', 'complaint-abc234@greenco.co.uk'],
    },
    index,
  );
  assert.deepEqual(m, { complaintId: 'c1', method: 'address' });
});

test('address match is case-insensitive', () => {
  const m = matchEmailToComplaint(
    { toAddresses: ['COMPLAINT-XYZ789@GREENCO.CO.UK'] },
    index,
  );
  assert.equal(m.complaintId, 'c2');
  assert.equal(m.method, 'address');
});

test('falls back to the ref code in the subject/body', () => {
  const m = matchEmailToComplaint(
    { subject: 'About complaint gc-c-xyz789', toAddresses: [] },
    index,
  );
  assert.deepEqual(m, { complaintId: 'c2', method: 'ref_code' });
});

test('address takes precedence over ref code', () => {
  const m = matchEmailToComplaint(
    {
      subject: 'mentions GC-C-XYZ789',
      toAddresses: ['complaint-abc234@greenco.co.uk'],
    },
    index,
  );
  assert.equal(m.complaintId, 'c1');
  assert.equal(m.method, 'address');
});

test('unrelated mail is unmatched', () => {
  const m = matchEmailToComplaint(
    { subject: 'Newsletter', bodyPreview: 'buy now', toAddresses: ['news@example.com'] },
    index,
  );
  assert.deepEqual(m, { complaintId: null, method: 'unmatched' });
});
