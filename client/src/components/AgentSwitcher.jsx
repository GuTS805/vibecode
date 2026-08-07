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
          >
            <span className="tab-name">{a.name}</span>
            <span className="tab-count">{a.posts}</span>
          </button>
        ))}
      </div>
      <button className="btn btn-ghost btn-sm" onClick={onNew}>
        + New agent
      </button>
    </nav>
  );
}
