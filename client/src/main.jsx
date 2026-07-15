import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './index.css';
import { AuthProvider, useAuth } from './auth.jsx';
import App from './App.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Companies from './pages/Companies.jsx';
import CompanyDetail from './pages/CompanyDetail.jsx';
import Tasks from './pages/Tasks.jsx';

function Gate() {
  const { user, loading } = useAuth();
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
