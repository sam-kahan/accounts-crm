// ---------------------------------------------------------------------------
// Who may do what.
//
// The app is used by one department, but not everyone in it should reach
// everything: some people work the complaints, some the commission, some are
// only ever meant to look. Access is described in two parts —
//
//   role         admin | staff | readonly. 'admin' is absolute: full access to
//                everything, including user management, so the person who can
//                fix a mistake can never be locked out by one.
//   permissions  {section: level} for staff and readonly. The role sets the
//                starting point; this is what is enforced.
//
// Everything here is pure so the rules can be unit-tested directly, and the
// same functions decide what the server allows and what the UI offers — a
// hidden button and a rejected request must never disagree.
// ---------------------------------------------------------------------------

export const ROLES = ['admin', 'staff', 'readonly'];
export const LEVELS = ['none', 'view', 'edit'];

// The parts of the app access is granted over. Kept deliberately coarse: one
// entry per area of the nav, because a list nobody can hold in their head is a
// list nobody sets correctly.
export const SECTIONS = [
  {
    key: 'companies',
    label: 'Companies & key dates',
    description: 'The company register, statutory dates and Companies House sync.',
  },
  {
    key: 'tasks',
    label: 'Tasks',
    description: 'The to-do list and its due dates.',
  },
  {
    key: 'complaints',
    label: 'Complaints',
    description: 'Complaints against councils and suppliers, and the organisations behind them.',
  },
  {
    key: 'commission',
    label: 'Commission',
    description: 'Contractors, the invoices they send, and the commission invoices raised back.',
  },
  {
    key: 'admin',
    label: 'Staff & access',
    description: 'Adding people to this system and setting what they can reach.',
  },
];

export const SECTION_KEYS = SECTIONS.map((s) => s.key);

// What each role starts as. Ticking a box afterwards is what makes it precise.
export const ROLE_DEFAULTS = {
  admin: Object.fromEntries(SECTION_KEYS.map((k) => [k, 'edit'])),
  staff: Object.fromEntries(SECTION_KEYS.map((k) => [k, k === 'admin' ? 'none' : 'edit'])),
  readonly: Object.fromEntries(SECTION_KEYS.map((k) => [k, k === 'admin' ? 'none' : 'view'])),
};

export const ROLE_LABEL = {
  admin: 'Administrator',
  staff: 'Staff',
  readonly: 'Read only',
};

export const ROLE_DESCRIPTION = {
  admin: 'Everything, including adding staff and setting their access.',
  staff: 'Works in the sections you tick below.',
  readonly: 'Can look at the sections you tick, but change nothing.',
};

function isLevel(value) {
  return LEVELS.includes(value);
}

// Coerce whatever arrives into a permissions map we can trust: known sections
// only, known levels only, everything else dropped rather than guessed at.
export function normalisePermissions(input, role = 'staff') {
  const source = input && typeof input === 'object' ? input : {};
  const defaults = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.staff;
  const out = {};
  for (const key of SECTION_KEYS) {
    out[key] = isLevel(source[key]) ? source[key] : defaults[key];
  }
  return out;
}

// What this user may actually do, section by section. An admin is always full
// access whatever is stored against them, so the role is the single thing to
// change to restore somebody — and a deactivated account can do nothing at all.
export function effectivePermissions(user) {
  if (!user || user.active === false) {
    return Object.fromEntries(SECTION_KEYS.map((k) => [k, 'none']));
  }
  if (user.role === 'admin') return { ...ROLE_DEFAULTS.admin };
  return normalisePermissions(user.permissions, user.role || 'staff');
}

const RANK = { none: 0, view: 1, edit: 2 };

// Does this user have at least `needed` access to `section`?
export function can(user, section, needed = 'view') {
  const level = effectivePermissions(user)[section] || 'none';
  return RANK[level] >= (RANK[needed] ?? RANK.view);
}

// What a request needs to be allowed: reading is 'view', anything that could
// change something is 'edit'. Deliberately blunt — a POST that only reads (an
// AI draft, a search) costs a read-only user nothing but access they wouldn't
// have had, whereas mistaking a write for a read would let them change data.
export function levelForMethod(method) {
  return String(method || '').toUpperCase() === 'GET' ? 'view' : 'edit';
}

// The sections this user can reach at all, for building their menu.
export function visibleSections(user) {
  const perms = effectivePermissions(user);
  return SECTIONS.filter((s) => perms[s.key] !== 'none').map((s) => s.key);
}

// What the client is told about itself. The UI uses exactly what the server
// enforces, so a button is never offered for something that would be refused.
export function describeAccess(user) {
  return {
    role: user?.role || 'staff',
    permissions: effectivePermissions(user),
    sections: visibleSections(user),
  };
}
