import { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../api';
import { useAuth } from '../auth.jsx';

// My signature: the details every email I send from here is signed with,
// and what it will look like. Each line shows only when it is filled in.
const FIELDS = [
  ['name', 'Name', 'e.g. Sam Kahan'],
  ['post_nominals', 'Letters after your name', 'e.g. MAAT'],
  ['job_title', 'Job title', 'e.g. Finance Director'],
  ['direct_line', 'Direct line', 'e.g. 0161 850 8687'],
  ['office_phone', 'Office', 'e.g. 0161 708 8629'],
  ['mobile', 'Mobile', ''],
];

export default function SignatureModal({ onClose }) {
  const { user, refresh } = useAuth();
  const [form, setForm] = useState(() => Object.fromEntries(FIELDS.map(([k]) => [k, user?.[k] || ''])));
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const set = (k, v) => { setSaved(false); setForm((f) => ({ ...f, [k]: v })); };

  // The preview follows the typing, a moment after it stops.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.auth.previewSignature(form).then((p) => live && setPreview(p)).catch(() => live && setPreview(null));
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [form]);

  async function save(e) {
    e.preventDefault();
    if (!form.name.trim()) { setError('Your name is needed: it signs every email.'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.auth.saveSignature(form);
      await refresh();
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="My signature"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{saved ? 'Done' : 'Cancel'}</button>
          <button className="btn-primary" form="signature-form" disabled={busy}>
            {busy ? 'Saving…' : saved ? 'Saved' : 'Save'}
          </button>
        </>
      }
    >
      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Every email you send from here (complaint emails, commission invoices) ends with this signature.
        A line left blank is left out.
      </p>
      <form id="signature-form" onSubmit={save}>
        <div className="form-grid">
          {FIELDS.map(([k, label, placeholder]) => (
            <label className="field" key={k}>
              <span className="lbl">{label}</span>
              <input
                type={['direct_line', 'office_phone', 'mobile'].includes(k) ? 'tel' : 'text'}
                value={form[k]}
                placeholder={placeholder}
                onChange={(e) => set(k, e.target.value)}
              />
            </label>
          ))}
        </div>
      </form>
      <div className="section-title" style={{ marginTop: 8 }}>How it looks</div>
      {preview?.enabled === false && (
        <div className="inline-note warn" style={{ marginBottom: 8 }}>The full signature is switched off on the server (EMAIL_SIGNATURE=off).</div>
      )}
      {preview ? (
        <div
          style={{ background: '#fff', border: '1px solid var(--border, #e5e7eb)', borderRadius: 8, padding: 14, overflowX: 'auto' }}
          // Built on the server from your own details, every value escaped.
          dangerouslySetInnerHTML={{ __html: preview.html }}
        />
      ) : (
        <div className="muted" style={{ fontSize: 13 }}>Loading the preview…</div>
      )}
    </Modal>
  );
}
