import { useState } from 'react';

const PRESETS = [
  { name: 'Ada', domain: 'AI Security' },
  { name: 'Turing', domain: 'AI Research' },
  { name: 'Grace', domain: 'AI Policy & Regulation' },
];

export default function InitForm({ onCreate, onCancel, canCancel }) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (!name.trim() || !domain.trim()) {
      setError('Both a name and a domain are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(name.trim(), domain.trim());
      setName('');
      setDomain('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card panel">
      <h2 className="panel-title">Initialize an agent</h2>
      <p className="muted small">
        One call starts it. From then on it discovers, judges, and publishes on its own for 48
        hours — no further input needed.
      </p>

      <form onSubmit={submit} className="init-form">
        <label>
          <span>Persona name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ada"
            maxLength={60}
            disabled={busy}
          />
        </label>
        <label>
          <span>Domain / beat</span>
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="AI Security"
            maxLength={120}
            disabled={busy}
          />
        </label>

        <div className="preset-row">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              className="chip chip-btn"
              onClick={() => {
                setName(p.name);
                setDomain(p.domain);
              }}
              disabled={busy}
            >
              {p.name} · {p.domain}
            </button>
          ))}
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Initializing…' : 'Initialize agent'}
          </button>
          {canCancel && (
            <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
