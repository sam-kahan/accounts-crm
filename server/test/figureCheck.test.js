import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountsIn, verifiedCorrection, applyFigureCheck, figureNote, formatPounds } from '../src/services/figureCheck.js';

const SOURCES = [
  'Document statement.jpeg: LivingCity statement, 31 Jul 2026: rent nil; £624.48 admin fee, £42 and £210 referral fees; total due £876.48',
  'Document breakdown.jpeg: Brethertons breakdown: arrears £876.48, legal costs £384, interest £28.67, land registry £8.40, total £1,297.55',
  'Email from Greenco: we ask for a refund of the £1,297.55 paid.',
].join('\n');
const BODY = 'Dear Paul,\n\nWe paid £1,297.55 under protest. We ask for a refund of the fees, legal costs, interest and Land Registry fee, £673.07 in total.\n\nKind regards,';

test('money is read to the penny, however it is written', () => {
  assert.deepEqual(amountsIn('£1,297.55, £252 and £ 28.67; not 673.07 or £5000000.1x'), [129755, 25200, 2867, 500000000]);
  assert.equal(formatPounds(129755), '£1,297.55');
  assert.equal(formatPounds(25200), '£252');
});

test('a correction is trusted only when its parts add up and every part is on file', () => {
  const onFile = new Set(amountsIn(SOURCES));
  const good = { correct: 1297.55, parts: [{ amount: 624.48 }, { amount: 42 }, { amount: 210 }, { amount: 384 }, { amount: 28.67 }, { amount: 8.40 }] };
  assert.equal(verifiedCorrection(good, onFile), true);
  assert.equal(verifiedCorrection({ ...good, correct: 1297.56 }, onFile), false); // a penny out
  assert.equal(verifiedCorrection({ correct: 1297.55, parts: [{ amount: 1000 }, { amount: 297.55 }] }, onFile), false); // not on file
  assert.equal(verifiedCorrection({ correct: 5, parts: [] }, onFile), false);
});

test('the Livingcity refund: £673.07 left out the admin fee, and is put right to £1,297.55', () => {
  const answer = {
    issues: [{ figure: '£673.07', problem: 'It leaves out the £624.48 Credit Control Admin Fee the email disputes; everything paid comes to £1,297.55.', correct: 1297.55,
      parts: [{ amount: 624.48 }, { amount: 42 }, { amount: 210 }, { amount: 384 }, { amount: 28.67 }, { amount: 8.4 }] }],
    corrected_body: BODY.replace('£673.07', '£1,297.55'),
  };
  const { body, check } = applyFigureCheck(BODY, answer, SOURCES);
  assert.ok(body.includes('£1,297.55 in total'));
  assert.ok(!body.includes('673.07'));
  assert.equal(check.amended, true);
  assert.match(figureNote(check), /£673\.07 was wrong and has been changed to £1,297\.55/);
});

test('a corrected email that brings in a figure not on file is not used; the verified figure is swapped instead', () => {
  const answer = {
    issues: [{ figure: '£673.07', problem: 'Leaves out the admin fee.', correct: 1297.55,
      parts: [{ amount: 876.48 }, { amount: 384 }, { amount: 28.67 }, { amount: 8.4 }] }],
    corrected_body: `${BODY.replace('£673.07', '£1,297.55')} We also ask for £50 compensation.`,
  };
  const { body, check } = applyFigureCheck(BODY, answer, SOURCES);
  assert.ok(!body.includes('£50'));
  assert.ok(body.includes('£1,297.55 in total'));
  assert.equal(check.amended, true);
});

test('a problem the facts on file can\'t settle is shown for a person, the draft left as it is', () => {
  const answer = { issues: [{ figure: '£673.07', problem: 'Not a figure on file; check what is being asked for.', correct: null, parts: [] }], corrected_body: null };
  const { body, check } = applyFigureCheck(BODY, answer, SOURCES);
  assert.equal(body, BODY);
  assert.equal(check.amended, false);
  assert.match(figureNote(check), /^Check £673\.07: Not a figure on file/);
  // Nothing wrong: nothing said.
  assert.equal(figureNote(applyFigureCheck(BODY, { issues: [] }, SOURCES).check), null);
});
