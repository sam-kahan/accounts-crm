import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import ChangePasswordModal from './components/ChangePasswordModal.jsx';

const AREAS = [
  {
    heading: 'Accounts',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: '◧' },
      { to: '/companies', label: 'Companies', icon: '▤' },
      { to: '/tasks', label: 'Tasks', icon: '✓' },
    ],
  },
  {
    heading: 'Complaints',
    items: [
      { to: '/complaints', label: 'Complaints', icon: '⚑' },
      { to: '/organisations', label: 'Organisations', icon: '☰' },
    ],
  },
];

const TITLES = {
  '/dashboard': 'Accounts — Dashboard',
  '/companies': 'Companies',
  '/tasks': 'Tasks',
  '/complaints': 'Complaints',
  '/organisations': 'Organisations',
};

export default function App() {
  const { pathname } = useLocation();
  const { user, logout } = useAuth();
  const [showChangePw, setShowChangePw] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const title =
    TITLES[pathname] ||
    (pathname.startsWith('/companies/') ? 'Company' :
      pathname.startsWith('/complaints/') ? 'Complaint' : 'Greenco CRM');

  return (
    <div className="app">
      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="brand">
          <img src="/brand/wordmark-on-navy.svg" alt="Greenco" />
        </div>
        <nav>
          {AREAS.map((area) => (
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
