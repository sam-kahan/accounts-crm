import { useState } from 'react';
import { useAuth } from '../auth';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
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

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <img
          className="login-logo"
          src="/brand/wordmark-on-navy.svg"
          alt="Greenco"
        />
        <div className="login-sub">Accounts CRM</div>

        {error && <div className="login-error">{error}</div>}

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
      </form>
      <div className="login-foot">accounts.greenco.co.uk</div>
    </div>
  );
}
