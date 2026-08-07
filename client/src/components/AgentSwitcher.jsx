export default function AgentSwitcher({ agents, activeId, onSelect, onNew }) {
  if (!agents.length) return null;

  return (
    <nav className="switcher" aria-label="Switch agent">
      <div className="switcher-tabs">
        {agents.map((a) => (
          <button
            key={a.agentId}
            className={`tab${a.agentId === activeId ? ' tab-active' : ''}`}
            onClick={() => onSelect(a.agentId)}
            aria-current={a.agentId === activeId}
            title={`${a.name} — ${a.domain}`}
          >
            <span className="tab-label">
              <span className="tab-name">{a.name}</span>
              {/* With a full roster the names alone stop being distinguishable, so each tab
                  carries its beat. */}
              <span className="tab-beat">{a.domain}</span>
            </span>
            <span className="tab-count" title={`${a.posts} published`}>
              {a.posts}
            </span>
          </button>
        ))}
      </div>
      <button className="btn btn-ghost btn-sm" onClick={onNew}>
        + New agent
      </button>
    </nav>
  );
}
