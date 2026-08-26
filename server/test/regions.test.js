import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findOutwardCode,
  regionForPostcode,
  regionForAddress,
  regionForJob,
  isRegion,
  REGION_KEYS,
} from '../src/services/regions.js';

const regionOf = (address) => regionForAddress(address).region;

test('the postcode is found wherever it sits in the address', () => {
  assert.equal(findOutwardCode('15 New Cross St, Manchester M4 5AB'), 'M4');
  assert.equal(findOutwardCode('m4 5ab'), 'M4');
  assert.equal(findOutwardCode('Flat 2, 8 Sefton Road, Liverpool, L20 9JT'), 'L20');
  assert.equal(findOutwardCode('CH41 1AA Birkenhead'), 'CH41');
  // A bare outward code counts only as the last word, where a postcode would be.
  assert.equal(findOutwardCode('12 Bold Street, Liverpool L1'), 'L1');
  assert.equal(findOutwardCode('Flat 2B, 14 Mill Lane'), null);
  assert.equal(findOutwardCode(''), null);
  assert.equal(findOutwardCode(null), null);
});

test('Greater Manchester postcodes go to Manchester', () => {
  for (const pc of ['M20 4AB', 'M1 1AE', 'BL1 1AA', 'OL9 7AF', 'SK4 2LT', 'WN1 1XL']) {
    assert.equal(regionOf(`14 Somewhere Street, ${pc}`), 'manchester', pc);
  }
});

test('Merseyside postcodes go to Liverpool', () => {
  for (const pc of ['L1 8JQ', 'L18 3EF', 'L33 7XN']) {
    assert.equal(regionOf(`14 Somewhere Street, ${pc}`), 'liverpool', pc);
  }
});

test('the WA area is split the way the business splits it', () => {
  // Warrington is worked from Manchester...
  for (const pc of ['WA1 1AA', 'WA2 8TX', 'WA5 1DE', 'WA4 6PT']) {
    assert.equal(regionOf(`1 Test Road, ${pc}`), 'manchester', pc);
  }
  // ...and St Helens from Liverpool.
  for (const pc of ['WA9 1AA', 'WA10 2BX', 'WA11 7RP', 'WA12 8DD']) {
    assert.equal(regionOf(`1 Test Road, ${pc}`), 'liverpool', pc);
  }
  // Altrincham and Knutsford sit behind Manchester; Runcorn and Widnes in front
  // of Liverpool.
  assert.equal(regionOf('1 Test Road, WA14 1AA'), 'manchester');
  assert.equal(regionOf('1 Test Road, WA16 6AA'), 'manchester');
  assert.equal(regionOf('1 Test Road, WA7 1AA'), 'liverpool');
  assert.equal(regionOf('1 Test Road, WA8 0AA'), 'liverpool');
});

test('the Wirral is Liverpool, Chester is neither', () => {
  assert.equal(regionOf('2 Grange Road, Birkenhead CH41 2PE'), 'liverpool');
  assert.equal(regionOf('9 Banks Road, Heswall CH60 0DR'), 'liverpool');
  // Chester itself: not either office's ground, so it is put to a person.
  const chester = regionForAddress('5 Watergate Street, Chester CH1 2LA');
  assert.equal(chester.region, null);
  assert.match(chester.reason, /CH1/);
});

test('Southport is Liverpool, Preston is neither', () => {
  assert.equal(regionOf('30 Lord Street, Southport PR8 1RH'), 'liverpool');
  assert.equal(regionOf('4 Fishergate, Preston PR1 2AB'), null);
});

test('an address it cannot place says so instead of guessing', () => {
  for (const address of [
    '12 High Street, Birmingham B1 1AA',
    '1 Main Road, Frodsham WA6 7AA',
    'Unit 4, the industrial estate',
    '',
    null,
  ]) {
    const out = regionForAddress(address);
    assert.equal(out.region, null, String(address));
    assert.ok(out.reason.length > 0, 'a reason is always given');
  }
});

test('without a postcode the town places it', () => {
  assert.equal(regionOf('14 Barlow Moor Road, Didsbury, Manchester'), 'manchester');
  assert.equal(regionOf('8 Rodney Street, Liverpool'), 'liverpool');
  assert.equal(regionOf('22 Church Street, St Helens'), 'liverpool');
  assert.equal(regionOf('7 Sankey Street, Warrington'), 'manchester');
  assert.equal(regionForAddress('8 Rodney Street, Liverpool').source, 'town');
});

test('a town name used as a street name does not place the job', () => {
  // Liverpool Road runs through Eccles; Manchester Road through half of
  // Lancashire. Reading either as the town would bill the wrong company.
  assert.equal(regionOf('42 Liverpool Road, Eccles'), 'manchester');
  assert.equal(regionOf('42 Manchester Road, Warrington'), 'manchester');
  assert.equal(regionOf('9 Liverpool Road, Chester'), null);
  assert.equal(regionOf('16 Manchester Road, Southport'), 'liverpool');
});

test('a postcode always beats a town name in the same address', () => {
  // The town is the sorting office as often as the property. If there is a
  // postcode, it decides.
  assert.equal(regionOf('1 Test Road, Liverpool, WA1 1AA'), 'manchester');
  assert.equal(regionOf('1 Test Road, Manchester, L20 9JT'), 'liverpool');
  // ...including when the postcode is neither office's: better to ask than to
  // take the town's word for it.
  assert.equal(regionOf('1 Test Road, Manchester, B1 1AA'), null);
});

test('regionForPostcode takes a postcode with or without the inward half', () => {
  assert.equal(regionForPostcode('M20').region, 'manchester');
  assert.equal(regionForPostcode('M20 4AB').region, 'manchester');
  assert.equal(regionForPostcode('wa9').region, 'liverpool');
  assert.equal(regionForPostcode('ZZ99'), null);
  assert.equal(regionForPostcode(''), null);
});

test('only the two offices are regions', () => {
  assert.deepEqual(REGION_KEYS, ['manchester', 'liverpool']);
  assert.equal(isRegion('manchester'), true);
  assert.equal(isRegion('leeds'), false);
  assert.equal(isRegion(null), false);
});

test('a works date printed after the postcode does not hide it', () => {
  // Real invoice (Locksafe Locksmiths INV4628): "Work completed at 11 River
  // View, Birkenhead CH41 ON 15/06/26" — the ON is the word "on" before the
  // date, and it leaves the postcode looking like it has an inward half.
  const out = regionForAddress('11 River View, Birkenhead CH41 ON 15/06/26');
  assert.equal(out.region, 'liverpool');
  assert.equal(out.source, 'postcode');
  assert.match(out.reason, /CH41 is Birkenhead/);

  // The same address once the date has been cleaned off.
  assert.equal(regionOf('11 River View, Birkenhead CH41'), 'liverpool');
  // ...and with the stray "on" still attached.
  assert.equal(regionOf('11 River View, Birkenhead CH41 ON'), 'liverpool');
});

test('looking past the postcode never invents one deeper in the address', () => {
  // A postcode-shaped fragment that is part of the address, not the end of it.
  assert.equal(regionOf('Unit A4, Mill Lane, Southport PR8 1RH'), 'liverpool');
  // Neither office's ground: still nothing, rather than the nearest guess.
  assert.equal(regionOf('Unit B2, Mill Lane, Sheffield'), null);
  // A town still places an address with no postcode at all.
  assert.equal(regionForAddress('8 Rodney Street, Liverpool').source, 'town');
});

test("a contractor's usual office catches an address that can't be placed", () => {
  // The whole point: what the address says still wins. A Liverpool contractor's
  // Manchester job is Manchester.
  const manchesterJob = regionForJob('12 Oak Road, M20 2AB', 'liverpool', 'Acme');
  assert.equal(manchesterJob.region, 'manchester');
  assert.equal(manchesterJob.source, 'postcode');

  // No postcode and no town: this is what the fallback is for — the invoice
  // that says "the flat above the shop".
  const vague = regionForJob('The flat above the shop', 'liverpool', 'Acme');
  assert.equal(vague.region, 'liverpool');
  assert.equal(vague.source, 'contractor_default');
  assert.match(vague.reason, /Acme is set to Liverpool by default/);

  // A postcode in neither office's area is still not placed by the address, so
  // the fallback takes it rather than the form asking a question whose answer
  // never changes.
  const away = regionForJob('9 High Street, Sheffield S1 2HE', 'manchester', 'Acme');
  assert.equal(away.region, 'manchester');
  assert.equal(away.source, 'contractor_default');
});

test('no default set leaves the answer exactly as the address gave it', () => {
  const vague = regionForJob('The flat above the shop', null, 'Acme');
  assert.equal(vague.region, null);
  assert.equal(vague.source, null);
  assert.deepEqual(vague.reason, regionForAddress('The flat above the shop').reason);
  // A junk default is not a default.
  assert.equal(regionForJob('The flat above the shop', 'birmingham').region, null);
});
