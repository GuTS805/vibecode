import { useEffect, useState } from 'react';
import * as api from '../api';

const CUSTOM = '__custom__';

/**
 * Persona picker.
 *
 * The roster is fetched from /api/personas rather than hardcoded here — the registry in
 * src/persona.json is the single source of truth for who exists, and a duplicated list in
 * the UI would drift the first time a persona is added or renamed.
 *
 * Picking a name from the registry gets that persona's authored beat, voice, and opinions.
 * The custom option is still available and goes through the same endpoint; it resolves to a
 * matching persona by domain where one exists, and to the fallback template otherwise.
 */
export default function InitForm({ onCreate, onCancel, canCancel, existingAgents = [] }) {
  const [personas, setPersonas] = useState([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState(null);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listPersonas()
      .then(({ personas }) => {
        if (cancelled) return;
        setPersonas(personas);
        // Preselect the first persona that isn't already running.
        const taken = new Set(existingAgents.map((a) => a.name.toLowerCase()));
        const first = personas.find((p) => !taken.has(p.name.toLowerCase())) || personas[0];
        if (first) setSelected(first.name);
      })
      // The custom fields still work without the roster, so this degrades rather than breaks.
      .catch(() => !cancelled && setLoadFailed(true));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isRunning = (personaName) =>
    existingAgents.some((a) => a.name.toLowerCase() === personaName.toLowerCase());

  const chosen = personas.find((p) => p.name === selected) || null;

  async function submit(e) {
    e.preventDefault();
    const payload =
      selected === CUSTOM || !chosen
        ? { name: name.trim(), domain: domain.trim() }
        : { name: chosen.name, domain: chosen.domain };

    if (!payload.name || !payload.domain) {
      setError('Both a name and a beat are required.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await onCreate(payload.name, payload.domain);
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
        hours — no further input needed. Agents run in parallel, each on its own schedule.
      </p>

      <form onSubmit={submit} className="init-form">
        {loadFailed && (
          <p className="form-error">
            Could not load the persona roster. You can still enter a name and beat below.
          </p>
        )}

        {personas.length > 0 && (
          <>
            <span className="field-label">Choose a persona</span>
            <div className="persona-grid" role="radiogroup" aria-label="Choose a persona">
              {personas.map((p) => {
                const running = isRunning(p.name);
                const active = selected === p.name;
                return (
                  <button
                    key={p.name}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`persona-card${active ? ' persona-card-active' : ''}`}
                    onClick={() => setSelected(p.name)}
                    disabled={busy}
                  >
                    <span className="persona-head">
                      <span className="persona-name">{p.name}</span>
                      {running && <span className="persona-live">running</span>}
                    </span>
                    <span className="persona-role">{p.role}</span>
                    <span className="persona-beat">{p.domain}</span>
                    <span className="persona-tagline">{p.tagline}</span>
                  </button>
                );
              })}

              <button
                type="button"
                role="radio"
                aria-checked={selected === CUSTOM}
                className={`persona-card persona-card-custom${
                  selected === CUSTOM ? ' persona-card-active' : ''
                }`}
                onClick={() => setSelected(CUSTOM)}
                disabled={busy}
              >
                <span className="persona-head">
                  <span className="persona-name">Custom</span>
                </span>
                <span className="persona-role">Your own persona</span>
                <span className="persona-tagline">
                  Name it and give it a beat. A matching beat inherits that persona&rsquo;s voice;
                  anything else gets the generic template.
                </span>
              </button>
            </div>
          </>
        )}

        {/* What this persona will and won't write about — the editorial contract, visible
            before you commit to starting it. */}
        {chosen && selected !== CUSTOM && (
          <div className="persona-detail">
            <div>
              <span className="detail-label">Covers</span>
              <ul className="detail-list">
                {chosen.covers.slice(0, 3).map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
            <div>
              <span className="detail-label">Never covers</span>
              <ul className="detail-list detail-list-neg">
                {chosen.avoids.slice(0, 3).map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
            <p className="muted small detail-foot">Posts are {chosen.postLength}.</p>
          </div>
        )}

        {(selected === CUSTOM || personas.length === 0) && (
          <div className="custom-fields">
            <label>
              <span>Persona name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Bob"
                maxLength={60}
                disabled={busy}
              />
            </label>
            <label>
              <span>Beat / domain</span>
              <input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="History"
                maxLength={120}
                disabled={busy}
              />
            </label>
          </div>
        )}

        {error && <p className="form-error">{error}</p>}

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy
              ? 'Initializing…'
              : chosen && selected !== CUSTOM
                ? `Start ${chosen.name}`
                : 'Initialize agent'}
          </button>
          {canCancel && (
            <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          )}
        </div>

        {chosen && selected !== CUSTOM && isRunning(chosen.name) && (
          <p className="muted small">
            {chosen.name} is already running. Starting again creates a second independent agent
            with the same voice and a separate feed.
          </p>
        )}
      </form>
    </section>
  );
}
