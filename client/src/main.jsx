import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './index.css';
import { AuthProvider, useAuth } from './auth.jsx';
import App from './App.jsx';
import Login from './pages/Login.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Companies from './pages/Companies.jsx';
import CompanyDetail from './pages/CompanyDetail.jsx';
import Tasks from './pages/Tasks.jsx';
import Complaints from './pages/Complaints.jsx';
import ComplaintDetail from './pages/ComplaintDetail.jsx';
import Organisations from './pages/Organisations.jsx';

function Gate() {
  const { user, loading } = useAuth();

  // The reset link is reachable without a session.
  const params = new URLSearchParams(window.location.search);
  if (window.location.pathname === '/reset' && params.get('token')) {
    return <ResetPassword token={params.get('token')} />;
  }

  if (loading) return <div className="spinner">Loading…</div>;
  if (!user) return <Login />;
  return (
    <Routes>
      <Route element={<App />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="companies" element={<Companies />} />
        <Route path="companies/:id" element={<CompanyDetail />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="complaints" element={<Complaints />} />
        <Route path="complaints/:id" element={<ComplaintDetail />} />
        <Route path="organisations" element={<Organisations />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </AuthProvider>
  </React.StrictMode>,
);

// Register the PWA service worker (installable app + offline shell).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        // When a new build's SW installs while a page is already controlled,
        // offer a manual reload rather than yanking the app out from under the
        // user mid-task.
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateToast();
            }
          });
        });
      })
      .catch(() => {
        /* SW registration is best-effort */
      });
  });
}

// Small brand-styled "new version" toast with a Reload button. Vanilla DOM so
// it works regardless of React's render state; shown at most once.
function showUpdateToast() {
  if (document.getElementById('sw-update-toast')) return;
  const bar = document.createElement('div');
  bar.id = 'sw-update-toast';
  bar.setAttribute('role', 'status');
  bar.style.cssText =
    'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:9999;' +
    'display:flex;gap:12px;align-items:center;background:#1e2235;color:#fff;' +
    'padding:10px 14px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.25);' +
    "font:14px/1.3 'Inter',system-ui,sans-serif;max-width:calc(100vw - 32px);";
  const msg = document.createElement('span');
  msg.textContent = 'A new version is available.';
  const btn = document.createElement('button');
  btn.textContent = 'Reload';
  btn.style.cssText =
    'background:#a2c533;color:#1e2235;border:0;border-radius:8px;padding:6px 12px;' +
    'font-weight:600;cursor:pointer;';
  btn.addEventListener('click', () => window.location.reload());
  bar.append(msg, btn);
  document.body.appendChild(bar);
}
