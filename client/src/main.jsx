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
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* SW registration is best-effort */
    });
  });
}
