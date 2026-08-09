import { monogram, personaAccent } from '../api';

/**
 * Sticky application bar: identity, agent switching, theme.
 *
 * The switcher is a horizontal rail of monogram chips rather than the old text tabs. With
 * six personas the text version wrapped onto three lines and pushed the feed below the
 * fold; monograms keep the whole roster on one row at any width, and each carries its
 * persona accent so the active agent is identifiable without reading it.
 */
export default function TopBar({ agents, activeId, onSelect, onNew, theme, onToggleTheme, userEmail, onSignOut }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-text">
            <strong>Persona Agents</strong>
            <span className="brand-sub">autonomous · self-scheduling</span>
          </span>
        </div>

        {agents.length > 0 && (
          <nav className="agent-rail" aria-label="Switch agent">
            {agents.map((a) => {
              const active = a.agentId === activeId;
              return (
                <button
                  key={a.agentId}
                  className={`agent-chip${active ? ' agent-chip-active' : ''}`}
                  data-accent={personaAccent(a.domain)}
                  onClick={() => onSelect(a.agentId)}
                  aria-current={active ? 'true' : undefined}
                  title={`${a.name} — ${a.domain} · ${a.posts} published`}
                >
                  <span className="agent-chip-mono" aria-hidden="true">
                    {monogram(a.name)}
                  </span>
                  <span className="agent-chip-label">
                    <span className="agent-chip-name">{a.name}</span>
                    <span className="agent-chip-beat">{a.domain}</span>
                  </span>
                  {a.posts > 0 && <span className="agent-chip-count">{a.posts}</span>}
                </button>
              );
            })}
          </nav>
        )}

        <div className="topbar-actions">
          <button className="icon-btn" onClick={onNew} title="Initialize a new agent">
            <span aria-hidden="true">＋</span>
            <span className="sr-only">New agent</span>
          </button>
          <button
            className="icon-btn"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
          </button>
          {onSignOut && (
            <button className="icon-btn" onClick={onSignOut} title={userEmail ? `Sign out (${userEmail})` : 'Sign out'}>
              <span aria-hidden="true">⎋</span>
              <span className="sr-only">Sign out</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
