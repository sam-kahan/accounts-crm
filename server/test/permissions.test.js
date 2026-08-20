import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  can,
  levelForMethod,
  effectivePermissions,
  normalisePermissions,
  visibleSections,
  describeAccess,
  SECTION_KEYS,
  ROLE_DEFAULTS,
} from '../src/services/permissions.js';

const admin = { role: 'admin', permissions: {}, active: true };
const staff = {
  role: 'staff',
  active: true,
  permissions: { companies: 'edit', tasks: 'view', complaints: 'none', commission: 'edit', admin: 'none' },
};
const readonly = { role: 'readonly', active: true, permissions: ROLE_DEFAULTS.readonly };

test('an administrator has everything, whatever is stored against them', () => {
  // The role is the one thing to change to restore somebody, so it can't be
  // undermined by a stale or malformed permissions blob.
  const odd = { role: 'admin', active: true, permissions: { commission: 'none', admin: 'none' } };
  for (const section of SECTION_KEYS) {
    assert.equal(can(odd, section, 'edit'), true, section);
  }
});

test('staff get exactly what was ticked', () => {
  assert.equal(can(staff, 'companies', 'edit'), true);
  assert.equal(can(staff, 'tasks', 'view'), true);
  assert.equal(can(staff, 'tasks', 'edit'), false); // view only
  assert.equal(can(staff, 'complaints', 'view'), false); // no access at all
  assert.equal(can(staff, 'admin', 'view'), false);
});

test('read-only can look everywhere it is allowed and change nothing', () => {
  for (const section of ['companies', 'tasks', 'complaints', 'commission']) {
    assert.equal(can(readonly, section, 'view'), true, section);
    assert.equal(can(readonly, section, 'edit'), false, section);
  }
  assert.equal(can(readonly, 'admin', 'view'), false);
});

test('a deactivated account can do nothing, even as an administrator', () => {
  const gone = { role: 'admin', active: false, permissions: {} };
  for (const section of SECTION_KEYS) {
    assert.equal(can(gone, section, 'view'), false, section);
  }
  assert.deepEqual(visibleSections(gone), []);
});

test('no user at all is no access', () => {
  assert.equal(can(null, 'companies', 'view'), false);
  assert.equal(can(undefined, 'admin', 'edit'), false);
});

test('reading needs view, anything that could change needs edit', () => {
  assert.equal(levelForMethod('GET'), 'view');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
    assert.equal(levelForMethod(method), 'edit', method);
  }
  // Unknown or missing methods are treated as writes, not reads.
  assert.equal(levelForMethod(undefined), 'edit');
});

test('permissions are clamped to known sections and levels', () => {
  const cleaned = normalisePermissions(
    { companies: 'edit', tasks: 'god-mode', nonsense: 'edit', admin: 'view' },
    'readonly',
  );
  assert.equal(cleaned.companies, 'edit');
  assert.equal(cleaned.tasks, 'view'); // unknown level -> the role's default
  assert.equal(cleaned.admin, 'view');
  assert.equal(cleaned.nonsense, undefined); // unknown section dropped
  assert.deepEqual(Object.keys(cleaned).sort(), [...SECTION_KEYS].sort());
});

test('junk in place of permissions falls back to the role, not to nothing', () => {
  for (const junk of [null, undefined, 'everything', 42, []]) {
    assert.deepEqual(normalisePermissions(junk, 'staff'), ROLE_DEFAULTS.staff);
  }
});

test('the menu is built from the same rules the server enforces', () => {
  assert.deepEqual(visibleSections(staff), ['companies', 'tasks', 'commission']);
  assert.deepEqual(visibleSections(admin), SECTION_KEYS);
  const described = describeAccess(staff);
  assert.equal(described.role, 'staff');
  assert.deepEqual(described.sections, ['companies', 'tasks', 'commission']);
  // Every section a user is told about is one they can actually reach.
  for (const section of described.sections) {
    assert.equal(can(staff, section, 'view'), true, section);
  }
});

test('effectivePermissions never leaves a section undefined', () => {
  const sparse = { role: 'staff', active: true, permissions: { companies: 'edit' } };
  const perms = effectivePermissions(sparse);
  for (const section of SECTION_KEYS) {
    assert.ok(['none', 'view', 'edit'].includes(perms[section]), section);
  }
  // Unstated sections fall back to what the role implies, not to full access.
  assert.equal(perms.admin, 'none');
});
