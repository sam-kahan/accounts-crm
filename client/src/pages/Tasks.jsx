import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate, dueClass } from '../api';
import Modal from '../components/Modal.jsx';
import { useAuth } from '../auth.jsx';

function AddTaskModal({ companies, onClose, onSaved }) {
  const [form, setForm] = useState({
    title: '',
    company_id: '',
    due_date: '',
    priority: 'medium',
    description: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.tasks.create({
        ...form,
        company_id: form.company_id || null,
        due_date: form.due_date || null,
      });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New task" onClose={onClose}>
      {error && <div className="inline-note warn" style={{ marginBottom: 14 }}>{error}</div>}
      <form onSubmit={save}>
        <label className="field">
          <span className="lbl">Task *</span>
          <input
            required
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="e.g. File CT600 for year end"
            autoFocus
          />
        </label>
        <div className="form-grid">
          <label className="field">
            <span className="lbl">Company</span>
            <select
              value={form.company_id}
              onChange={(e) => setForm({ ...form, company_id: e.target.value })}
            >
              <option value="">— None —</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lbl">Due date</span>
            <input
              type="date"
              value={form.due_date}
              onChange={(e) => setForm({ ...form, due_date: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="lbl">Priority</span>
            <select
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label className="field full">
            <span className="lbl">Notes</span>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>
        </div>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Add task'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function Tasks() {
  const mayEdit = useAuth().canEdit('tasks');
  const [tasks, setTasks] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [filter, setFilter] = useState('open'); // open | all | done
  const [showAdd, setShowAdd] = useState(false);
  const [err, setErr] = useState(null);

  // Only the answer to the latest request is shown: switching filters quickly
  // could otherwise leave an older, slower answer on screen under the new one.
  const latest = useRef(0);
  const load = () => {
    const params = filter === 'all' ? {} : filter === 'done' ? { status: 'done' } : {};
    const n = ++latest.current;
    setErr(null);
    return api.tasks
      .list(params)
      .then((rows) => {
        if (n !== latest.current) return;
        setTasks(filter === 'open' ? rows.filter((t) => t.status !== 'done') : rows);
      })
      .catch((e) => { if (n === latest.current) setErr(e.message); });
  };
  useEffect(() => {
    load();
  }, [filter]);
  useEffect(() => {
    api.companies.list().then(setCompanies).catch(() => setCompanies([]));
  }, []);

  // The task being ticked or deleted: its controls wait, so a double-click
  // can't tick it done and straight back again.
  const [working, setWorking] = useState(null);
  async function toggle(t) {
    if (working) return;
    const next = t.status === 'done' ? 'todo' : 'done';
    setWorking(t.id);
    try {
      await api.tasks.update(t.id, { status: next });
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setWorking(null);
    }
  }
  async function remove(t) {
    if (working || !confirm('Delete this task?')) return;
    setWorking(t.id);
    try {
      await api.tasks.remove(t.id);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setWorking(null);
    }
  }

  return (
    <>
      <div className="toolbar flex-between">
        <div className="btn-row">
          {['open', 'all', 'done'].map((f) => (
            <button
              key={f}
              className={filter === f ? 'btn-primary btn-sm' : 'btn-sm'}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        {mayEdit && <button className="btn-primary" onClick={() => setShowAdd(true)}>+ New task</button>}
      </div>

      {err && (
        <div className="inline-note warn" style={{ marginBottom: 12 }}>
          {err} <button className="linkish" onClick={load}>Retry</button>
        </div>
      )}

      <div className="card">
        {!tasks ? (
          err ? (
            <div className="empty">Couldn’t load tasks.</div>
          ) : (
            <div className="spinner">Loading…</div>
          )
        ) : tasks.length === 0 ? (
          <div className="empty">No tasks here.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 40 }}></th>
                <th>Task</th>
                <th>Company</th>
                <th>Due</th>
                <th>Priority</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td>
                    <input
                      type="checkbox"
                      style={{ width: 18, height: 18 }}
                      aria-label={`Mark "${t.title}" ${t.status === 'done' ? 'not done' : 'done'}`}
                      checked={t.status === 'done'}
                      disabled={!mayEdit || working === t.id}
                      onChange={() => toggle(t)}
                    />
                  </td>
                  <td style={{ textDecoration: t.status === 'done' ? 'line-through' : 'none', color: t.status === 'done' ? 'var(--text-muted)' : 'inherit' }}>
                    {t.title}
                  </td>
                  <td className="muted">
                    {t.company_id ? (
                      <Link to={`/companies/${t.company_id}`}>{t.company_name}</Link>
                    ) : '—'}
                  </td>
                  <td className={`due ${t.status !== 'done' ? dueClass(t.due_date) : ''}`}>
                    {formatDate(t.due_date)}
                  </td>
                  <td><span className={`badge ${t.priority}`}>{t.priority}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    {mayEdit && <button className="btn-danger btn-sm" disabled={working === t.id} onClick={() => remove(t)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAdd && (
        <AddTaskModal
          companies={companies}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}
    </>
  );
}
