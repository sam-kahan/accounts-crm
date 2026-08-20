import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import ChangePasswordModal from './components/ChangePasswordModal.jsx';

// `section` is the access a nav entry needs; entries without one are open to
// anyone signed in. The list is filtered against what the server granted, so
// the menu can't offer a page the API would refuse.
const AREAS = [
  {
    heading: 'Accounts',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: '◧' },
      { to: '/companies', label: 'Companies', icon: '▤', section: 'companies' },
      { to: '/tasks', label: 'Tasks', icon: '✓', section: 'tasks' },
    ],
  },
  {
    heading: 'Commission',
    items: [
      { to: '/commission/invoices', label: 'Invoices in', icon: '↓', section: 'commission' },
      { to: '/commission/raised', label: 'Commission invoices', icon: '£', section: 'commission' },
      { to: '/commission/contractors', label: 'Contractors', icon: '⚒', section: 'commission' },
    ],
  },
  {
    heading: 'Complaints',
    items: [
      { to: '/complaints', label: 'Complaints', icon: '⚑', section: 'complaints' },
      { to: '/organisations', label: 'Organisations', icon: '☰', section: 'complaints' },
    ],
  },
  {
    heading: 'Admin',
    items: [{ to: '/staff', label: 'Staff & access', icon: '⚙', section: 'admin' }],
  },
];

const TITLES = {
  '/dashboard': 'Accounts — Dashboard',
  '/companies': 'Companies',
  '/tasks': 'Tasks',
  '/complaints': 'Complaints',
  '/organisations': 'Organisations',
  '/commission/invoices': 'Contractor invoices',
  '/commission/raised': 'Commission invoices',
  '/commission/contractors': 'Contractors',
  '/staff': 'Staff & access',
};

export default function App() {
  const { pathname } = useLocation();
  const { user, logout, canView } = useAuth();
  // Only the areas this user can actually reach, and only headings that still
  // have something under them.
  const areas = AREAS.map((area) => ({
    ...area,
    items: area.items.filter((n) => !n.section || canView(n.section)),
  })).filter((area) => area.items.length > 0);
  const [showChangePw, setShowChangePw] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const title =
    TITLES[pathname] ||
    (pathname.startsWith('/companies/') ? 'Company' :
      pathname.startsWith('/complaints/') ? 'Complaint' :
        pathname.startsWith('/commission/raised/') ? 'Commission invoice' : 'Greenco CRM');

  return (
    <div className="app">
      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="brand">
          <img src="/brand/wordmark-on-navy.svg" alt="Greenco" />
        </div>
        <nav>
          {areas.map((area) => (
            <div className="nav-group" key={area.heading}>
              <div className="nav-heading">{area.heading}</div>
              {area.items.map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  onClick={() => setNavOpen(false)}
                  className={({ isActive }) => (isActive ? 'active' : '')}
                >
                  <span aria-hidden>{n.icon}</span>
                  {n.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="foot">
          {user && (
            <div className="user-box">
              <div className="user-name">{user.name || user.email}</div>
              {user.role && user.role !== 'admin' && (
                <div className="user-role">
                  {user.role === 'readonly' ? 'Read only' : 'Staff'}
                </div>
              )}
              <div className="user-actions">
                <button className="linkish" onClick={() => setShowChangePw(true)}>
                  Change password
                </button>
                <button className="signout" onClick={logout}>
                  Sign out
                </button>
              </div>
            </div>
          )}
          <div className="foot-app">Accounts CRM · accounts.greenco.co.uk</div>
        </div>
      </aside>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="hamburger"
              onClick={() => setNavOpen((o) => !o)}
              aria-label="Menu"
              aria-expanded={navOpen}
            >
              ☰
            </button>
            <h1>{title}</h1>
          </div>
        </header>
        <div className="content">
          <Outlet />
        </div>
      </div>
      {showChangePw && (
        <ChangePasswordModal onClose={() => setShowChangePw(false)} />
      )}
    </div>
  );
}
