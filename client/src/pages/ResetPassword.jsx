import { useState } from 'react';
import { api } from '../api';

export default function ResetPassword({ token }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.auth.reset(token, password);
      setDone(true);
    } catch (err) {
      setError(err.message || 'This reset link is invalid or has expired.');
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <img className="login-logo" src="/brand/wordmark-on-navy.svg" alt="Greenco" />
        <div className="login-sub">Reset password</div>

        {done ? (
          <>
            <p className="login-note">Your password has been reset.</p>
            <a className="btn-primary login-btn" href="/" style={{ display: 'block' }}>
              Sign in
            </a>
          </>
        ) : (
          <form onSubmit={submit}>
            {error && <div className="login-error">{error}</div>}
            <label className="field">
              <span className="lbl">New password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
              />
            </label>
            <label className="field">
              <span className="lbl">Confirm password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </label>
            <button className="btn-primary login-btn" disabled={busy}>
              {busy ? 'Saving…' : 'Set new password'}
            </button>
          </form>
        )}
      </div>
      <div className="login-foot">accounts.greenco.co.uk</div>
    </div>
  );
}
