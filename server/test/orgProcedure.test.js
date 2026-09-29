import { test } from 'node:test';
import assert from 'node:assert/strict';
import { procedureChanged, statesOwnProcedure } from '../src/services/orgProcedure.js';

const old = { type: 'debt_collector', ack_days: null, stage2_response_days: null, procedure_ref: null, ombudsman_id: null, procedure_sources: {} };

test('opening the form (blanks shown as the standard) and saving changes nothing procedural', () => {
  const next = { ...old, ack_days: 5, stage2_response_days: 20, procedure_sources: { ack_days: 'standard', stage2_response_days: 'standard' }, phone: '0161 000 0000' };
  assert.equal(procedureChanged(old, next), false);
});

test('a figure typed in, a procedure name, a type or a scheme is a change', () => {
  assert.equal(procedureChanged(old, { ...old, ack_days: 5, procedure_sources: { ack_days: 'entered' } }), true);
  assert.equal(procedureChanged(old, { ...old, procedure_ref: 'CP01' }), true);
  assert.equal(procedureChanged(old, { ...old, type: 'energy' }), true);
  assert.equal(procedureChanged(old, { ...old, ombudsman_id: '00000000-0000-0000-0000-000000000001' }), true);
  // Scheme not sent: left as it was.
  assert.equal(procedureChanged({ ...old, ombudsman_id: 'x' }, { ...old, ombudsman_id: undefined }), false);
});

test('an unchanged figure stays unchanged, whatever its number type', () => {
  const o = { ...old, ack_days: 3, procedure_sources: { ack_days: 'document' } };
  assert.equal(procedureChanged(o, { ...o, ack_days: '3' }), false);
  assert.equal(procedureChanged(o, { ...o, ack_days: 4 }), true);
});

test('only their own figures (not the standard) mean a procedure is on file', () => {
  assert.equal(statesOwnProcedure({ ack_days: 5, stage2_response_days: 20, procedure_sources: { ack_days: 'standard', stage2_response_days: 'standard' } }), false);
  assert.equal(statesOwnProcedure({ ack_days: 5, procedure_sources: { ack_days: 'entered' } }), true);
  assert.equal(statesOwnProcedure({ procedure_ref: 'Complaints policy v3', procedure_sources: {} }), true);
  assert.equal(statesOwnProcedure({ ack_days: '', procedure_sources: {} }), false);
});
