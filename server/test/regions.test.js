import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findOutwardCode,
  regionForPostcode,
  regionForAddress,
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
