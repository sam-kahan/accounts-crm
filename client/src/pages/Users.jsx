import { useEffect, useState } from 'react';
import { api, formatDate } from '../api';
import { useAuth } from '../auth.jsx';
import Modal from '../components/Modal.jsx';

// Staff accounts and what each person can reach. Administrators only — the API
// refuses everything here to anyone else, so this page is the convenient way to
// do it rather than the thing that makes it safe.

const LEVEL_LABEL = { none: 'No access', view: 'View only', edit: 'View & edit' };
const LEVEL_BADGE = { none: 'grey', view: 'navy', edit: 'green' };

function AccessGrid({ role, permissions, sections, onChange, disabled }) {
  return (
    <table style={{ marginBottom: 4 }}>
      <thead>
        <tr>
          <th>Section</th>
          <th style={{ width: 320 }}>Access</th>
        </tr>
      </thead>
      <tbody>
        {sections.map((s) => (
          <tr key={s.key}>
            <td>
              <strong>{s.label}</strong>
              <div className="muted" style={{ fontSize: 12 }}>{s.description}</div>
            </td>
            <td>
              <div className="btn-row" style={{ flexWrap: 'nowrap' }}>
                {['none', 'view', 'edit'].map((lvl) => (
                  <label
                    key={lvl}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: 13,
                      opacity: disabled ? 0.55 : 1,
                    }}
                  >
                    <input
                      type="radio"
                      name={`perm-${s.key}`}
                      checked={(permissions[s.key] || 'none') === lvl}
                      disabled={disabled}
                      onChange={() => onChange(s.key, lvl)}
                      style={{ width: 'auto' }}
                    />
                    {LEVEL_LABEL[lvl]}
                  </label>
                ))}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UserModal({ initial, options, onClose, onSaved }) {
  const { user: me } = useAuth();
  const isSelf = initial?.id === me?.id;
  const roles = options?.roles || [];
  const sections = options?.sections || [];

  const [form, setForm] = useState(
    initial
      ? {
          name: initial.name || '',
          email: initial.email,
          job_title: initial.job_title || '',
          role: initial.role,
          permissions: { ...initial.effective_permissions },
          active: initial.active,
        }
      : {
          name: '',
          email: '',
          job_title: '',
          role: 'staff',
          permissions: { ...(roles.find((r) => r.key === 'staff')?.defaults || {}) },
          active: true,
        },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Picking a role resets the ticks to that role's starting point; adjusting a
  // tick afterwards is what makes it precise.
  function chooseRole(role) {
    const defaults = roles.find((r) => r.key === role)?.defaults || {};
    setForm((f) => ({ ...f, role, permissions: { ...defaults } }));
  }

  const isAdmin = form.role === 'admin';

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = initial
        ? await api.users.update(initial.id, {
            name: form.name,
            job_title: form.job_title || null,
            role: form.role,
            permissions: form.permissions,
            active: form.active,
          })
        : await api.users.create({
            email: form.email,
            name: form.name,
            job_title: form.job_title || null,
            role: form.role,
            permissions: form.permissions,
          });
      onSaved(saved, !initial);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={initial ? `Edit ${initial.name || initial.email}` : 'Add someone'} onClose={onClose}>
      {error && <div className="login-error" style={{ marginBottom: 14 }}>{error}</div>}
      <form onSubmit={save}>
        <div className="form-grid">
          <label className="field">
            <span className="lbl">Name *</span>
            <input required value={form.name} onChange={(e) => set('name', e.target.value)} />
          </label>
          <label className="field">
            <span className="lbl">Email *</span>
            <input
              required
              type="email"
              value={form.email}
              disabled={!!initial}
              onChange={(e) => set('email', e.target.value)}
              placeholder="They'll be emailed a link to set a password"
            />
          </label>
          <label className="field full">
            <span className="lbl">Job title</span>
            <input
              value={form.job_title}
              onChange={(e) => set('job_title', e.target.value)}
              placeholder="e.g. Accounts assistant"
            />
          </label>
        </div>

        <div className="section-title" style={{ marginTop: 4 }}>What they can do</div>
        <div className="btn-row" style={{ marginBottom: 12 }}>
          {roles.map((r) => (
            <label
              key={r.key}
              className={`role-choice ${form.role === r.key ? 'chosen' : ''}`}
              title={r.description}
            >
              <input
                type="radio"
                name="role"
                checked={form.role === r.key}
                onChange={() => chooseRole(r.key)}
                style={{ width: 'auto' }}
              />
              <span>
                <strong>{r.label}</strong>
                <span className="muted" style={{ display: 'block', fontSize: 12 }}>
                  {r.description}
                </span>
              </span>
            </label>
          ))}
        </div>

        {isAdmin ? (
          <div className="inline-note" style={{ marginBottom: 14 }}>
            Administrators can reach everything, including this page. Nothing to tick.
          </div>
        ) : (
          <AccessGrid
            role={form.role}
            permissions={form.permissions}
            sections={sections}
            onChange={(key, level) =>
              setForm((f) => ({ ...f, permissions: { ...f.permissions, [key]: level } }))
            }
          />
        )}

        {initial && (
          <label
            className="field"
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}
          >
            <input
              type="checkbox"
              checked={!!form.active}
              disabled={isSelf}
              onChange={(e) => set('active', e.target.checked)}
              style={{ width: 'auto' }}
            />
            <span>
              Active — can sign in
              {isSelf && <span className="muted"> (you can’t deactivate yourself)</span>}
            </span>
          </label>
        )}

        <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>
            {busy ? 'Saving…' : initial ? 'Save' : 'Add & send invite'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function Users() {
  const { user: me } = useAuth();
  const [rows, setRows] = useState(null);
  const [options, setOptions] = useState(null);
  const [editing, setEditing] = useState(null); // user object or 'new'
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  const load = () => {
    setErr(null);
    return api.users
      .list()
      .then(setRows)
      .catch((e) => setErr(e.message));
  };

  useEffect(() => {
    load();
    api.users.options().then(setOptions).catch(() => setOptions(null));
  }, []);

  async function resend(u) {
    setMsg(null);
    try {
      const res = await api.users.invite(u.id);
      setMsg(
        res.invite?.sent
          ? `Invitation sent again to ${u.email}.`
          : `Email isn’t configured (${res.invite?.reason}). Send them this link yourself: ${res.invite?.link}`,
      );
    } catch (e) {
      setMsg(e.message);
    }
  }

  async function remove(u) {
    if (!confirm(`Remove ${u.name || u.email}? They were invited and never signed in.`)) return;
    try {
      await api.users.remove(u.id);
      await load();
    } catch (e) {
      setMsg(e.message);
    }
  }

  const mailerOff = options && options.mailer && !options.mailer.enabled;

  return (
    <>
      <div className="toolbar flex-between">
        <div className="muted">
          Everyone who can sign in, and what each of them can reach.
        </div>
        <button className="btn-primary" onClick={() => setEditing('new')}>+ Add someone</button>
      </div>

      {mailerOff && (
        <div className="inline-note warn" style={{ marginBottom: 12 }}>
          Email isn’t configured, so invitations can’t be sent. You’ll be shown the link to pass
          on instead — set <code>SMTP_USER</code> / <code>SMTP_PASS</code> to send them
          automatically.
        </div>
      )}
      {msg && <div className="inline-note" style={{ marginBottom: 12, wordBreak: 'break-all' }}>{msg}</div>}
      {err && (
        <div className="inline-note warn" style={{ marginBottom: 12 }}>
          {err} <button className="linkish" onClick={load}>Retry</button>
        </div>
      )}

      <div className="card">
        {!rows ? (
          err ? <div className="empty">Couldn’t load the staff list.</div> : <div className="spinner">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">Nobody yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Access</th>
                <th>Last signed in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} style={{ opacity: u.active ? 1 : 0.55 }}>
                  <td
                    className="clickable"
                    role="button"
                    tabIndex={0}
                    onClick={() => setEditing(u)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setEditing(u);
                      }
                    }}
                  >
                    <strong>{u.name || u.email}</strong>
                    {u.id === me?.id && <span className="badge green" style={{ marginLeft: 6 }}>you</span>}
                    {!u.active && <span className="badge grey" style={{ marginLeft: 6 }}>deactivated</span>}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {[u.job_title, u.email].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${u.role === 'admin' ? 'green' : 'navy'}`}>
                      {options?.roles?.find((r) => r.key === u.role)?.label || u.role}
                    </span>
                  </td>
                  <td>
                    {u.role === 'admin' ? (
                      <span className="muted" style={{ fontSize: 13 }}>Everything</span>
                    ) : (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {(options?.sections || [])
                          .filter((s) => (u.effective_permissions?.[s.key] || 'none') !== 'none')
                          .map((s) => (
                            <span
                              key={s.key}
                              className={`badge ${LEVEL_BADGE[u.effective_permissions[s.key]]}`}
                              title={LEVEL_LABEL[u.effective_permissions[s.key]]}
                            >
                              {s.label}
                              {u.effective_permissions[s.key] === 'view' ? ' (view)' : ''}
                            </span>
                          ))}
                        {(options?.sections || []).every(
                          (s) => (u.effective_permissions?.[s.key] || 'none') === 'none',
                        ) && <span className="muted" style={{ fontSize: 13 }}>Nothing yet</span>}
                      </div>
                    )}
                  </td>
                  <td className="muted">
                    {u.last_login_at ? (
                      formatDate(u.last_login_at)
                    ) : u.invited_at ? (
                      <span className="badge amber">invited, not yet signed in</span>
                    ) : (
                      <span title="This account is older than staff accounts, so there is nothing recorded yet — it will show the next time they sign in.">
                        —
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn-ghost btn-sm" onClick={() => setEditing(u)}>Edit</button>
                    {u.active && !u.last_login_at && u.invited_at && (
                      <button className="btn-ghost btn-sm" onClick={() => resend(u)}>Resend invite</button>
                    )}
                    {!u.last_login_at && u.invited_at && u.id !== me?.id && (
                      <button className="btn-danger btn-sm" onClick={() => remove(u)}>Remove</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <UserModal
          initial={editing === 'new' ? null : editing}
          options={options}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            setEditing(null);
            if (created) {
              setMsg(
                saved.invite?.sent
                  ? `${saved.name} has been emailed a link to set their password.`
                  : `Added. Email isn’t configured (${saved.invite?.reason}), so send them this link: ${saved.invite?.link}`,
              );
            } else {
              setMsg(null);
            }
            load();
          }}
        />
      )}
    </>
  );
}
