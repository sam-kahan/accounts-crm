import { NavLink, Outlet, useLocation } from 'react-router-dom';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: '◧' },
  { to: '/companies', label: 'Companies', icon: '▤' },
  { to: '/tasks', label: 'Tasks', icon: '✓' },
];

const TITLES = {
  '/dashboard': 'Dashboard',
  '/companies': 'Companies',
  '/tasks': 'Tasks',
};

export default function App() {
  const { pathname } = useLocation();
  const title =
    TITLES[pathname] ||
    (pathname.startsWith('/companies/') ? 'Company' : 'Accounts CRM');

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="/brand/wordmark-on-navy.svg" alt="Greenco" />
        </div>
        <nav>
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              <span aria-hidden>{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="foot">
          Greenco Accounts CRM
          <br />
          accounts.greenco.co.uk
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>
        </header>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
