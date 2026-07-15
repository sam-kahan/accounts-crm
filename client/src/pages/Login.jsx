import { useState } from 'react';
import { useAuth } from '../auth';
import { api } from '../api';

export default function Login() {
  const { login } = useAuth();
  const [mode, setMode] = useState('login'); // login | forgot
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submitLogin(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(
        err.status === 429
          ? 'Too many attempts — please wait a few minutes.'
          : 'Invalid email or password.',
      );
      setBusy(false);
    }
  }

  async function submitForgot(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.auth.forgot(email);
      setSent(true);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form
        className="login-card"
        onSubmit={mode === 'login' ? submitLogin : submitForgot}
      >
        <img className="login-logo" src="/brand/wordmark-on-navy.svg" alt="Greenco" />
        <div className="login-sub">Accounts CRM</div>

        {error && <div className="login-error">{error}</div>}

        {mode === 'login' ? (
          <>
            <label className="field">
              <span className="lbl">Email</span>
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </label>
            <label className="field">
              <span className="lbl">Password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <button className="btn-primary login-btn" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button
              type="button"
              className="login-link"
              onClick={() => {
                setMode('forgot');
                setError(null);
              }}
            >
              Forgot password?
            </button>
          </>
        ) : sent ? (
          <>
            <p className="login-note">
              If an account exists for <strong>{email}</strong>, we've emailed a
              reset link. It's valid for 1 hour.
            </p>
            <button
              type="button"
              className="btn login-btn"
              onClick={() => {
                setMode('login');
                setSent(false);
              }}
            >
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <p className="login-note">
              Enter your email and we'll send you a link to reset your password.
            </p>
            <label className="field">
              <span className="lbl">Email</span>
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </label>
            <button className="btn-primary login-btn" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
            <button
              type="button"
              className="login-link"
              onClick={() => {
                setMode('login');
                setError(null);
              }}
            >
              Back to sign in
            </button>
          </>
        )}
      </form>
      <div className="login-foot">accounts.greenco.co.uk</div>
    </div>
  );
}
