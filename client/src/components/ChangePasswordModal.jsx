import { useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../api';

export default function ChangePasswordModal({ onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.auth.changePassword(current, next);
      setDone(true);
    } catch (err) {
      setError(err.message || 'Could not change password.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Change password"
      onClose={onClose}
      footer={
        done ? (
          <button className="btn-primary" onClick={onClose}>Done</button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn-primary" form="change-pw-form" disabled={busy}>
              {busy ? 'Saving…' : 'Update password'}
            </button>
          </>
        )
      }
    >
      {done ? (
        <div className="inline-note">Your password has been updated.</div>
      ) : (
        <form id="change-pw-form" onSubmit={submit}>
          {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}
          <label className="field">
            <span className="lbl">Current password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label className="field">
            <span className="lbl">New password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span className="lbl">Confirm new password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </label>
        </form>
      )}
    </Modal>
  );
}
