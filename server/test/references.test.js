import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referenceLines, withReferences } from '../src/lib/references.js';

const tracks = [
  { key: 'main', org_name: 'LCS', reference: 'LCS-778812' },
  { key: 'p1', org_name: 'EDF Energy', reference: '6711 2345 90' },
];

test('each organisation is told its own reference and the other’s, labelled', () => {
  assert.deepEqual(referenceLines(tracks, 'p1'), ['Your reference: 6711 2345 90', 'LCS reference: LCS-778812']);
  assert.deepEqual(referenceLines(tracks, 'main'), ['Your reference: LCS-778812', 'EDF Energy reference: 6711 2345 90']);
  // To someone else (the ombudsman): each by name.
  assert.deepEqual(referenceLines(tracks, null), ['LCS reference: LCS-778812', 'EDF Energy reference: 6711 2345 90']);
  // A reference not known yet is left out, never "not known".
  assert.deepEqual(referenceLines([tracks[0], { ...tracks[1], reference: null }], 'p1'), ['LCS reference: LCS-778812']);
});

test('the missing references go under the greeting; one already quoted is not repeated', () => {
  const body = 'Dear EDF Energy,\n\nThe documents you asked for are attached.\n\nKind regards,';
  const out = withReferences(body, referenceLines(tracks, 'p1'));
  assert.equal(out, 'Dear EDF Energy,\n\nYour reference: 6711 2345 90\nLCS reference: LCS-778812\n\nThe documents you asked for are attached.\n\nKind regards,');
  // Written differently in the email (spaces, no hyphen) still counts as quoted.
  const has = 'Dear EDF Energy,\n\nYour ref 6711234590, LCS ref LCS778812.\n\nThanks';
  assert.equal(withReferences(has, referenceLines(tracks, 'p1')), has);
  // Only the one missing is added.
  const half = 'Hello Rebecca,\n\nYour reference 6711 2345 90.\n';
  assert.equal(withReferences(half, referenceLines(tracks, 'p1')), 'Hello Rebecca,\n\nLCS reference: LCS-778812\n\nYour reference 6711 2345 90.\n');
  // No greeting: at the top. Nothing known: unchanged.
  assert.match(withReferences('Please see below.', referenceLines(tracks, 'p1')), /^Your reference: 6711 2345 90\nLCS reference: LCS-778812\n\nPlease see below\.$/);
  assert.equal(withReferences(body, []), body);
});
