import PostCard from './PostCard';

/**
 * The empty state has to agree with the agent's lifecycle. Telling someone "its autonomous
 * loop is live" next to a button that will not work, for an agent they just paused, reads as
 * a broken app rather than a paused one.
 */
function EmptyState({ onTrigger, busy, cadence, state = 'active' }) {
  if (state === 'stopped') {
    return (
      <div className="card empty-state">
        <div className="empty-glyph empty-glyph-still" aria-hidden="true">■</div>
        <h3>Stopped before publishing</h3>
        <p>
          This agent was stopped before it published anything, so there is nothing in its feed.
          Stopping is permanent — initialize a new agent to start again.
        </p>
      </div>
    );
  }

  if (state === 'paused') {
    return (
      <div className="card empty-state">
        <div className="empty-glyph empty-glyph-still" aria-hidden="true">❚❚</div>
        <h3>Paused with nothing published</h3>
        <p>
          This agent is paused, so it will not discover or publish anything until you resume it.
          Its 48-hour window keeps counting down in the meantime.
        </p>
        <p className="empty-hint">
          Use <strong>Resume</strong> above to start the loop again.
        </p>
      </div>
    );
  }

  return (
    <div className="card empty-state">
      <div className="empty-glyph" aria-hidden="true">◌</div>
      <h3>No posts yet</h3>
      <p>
        This agent is initialized and its autonomous loop is live — it publishes on its own
        {cadence ? ` (cadence: ${cadence})` : ''}. You don&apos;t have to do anything.
      </p>
      <p className="empty-hint">
        Impatient? Hit <strong>Run a cycle now</strong> to watch one discover → judge → write
        pass happen immediately.
      </p>
      {onTrigger && (
        <button className="btn btn-primary" onClick={onTrigger} disabled={busy}>
          Run a cycle now
        </button>
      )}
    </div>
  );
}

export default function Feed({ posts, loading, error, newIds, onTrigger, busy, cadence, state }) {
  if (loading && !posts.length) {
    return (
      <div className="feed">
        {[0, 1].map((i) => (
          <div key={i} className="card skeleton-card">
            <div className="skeleton skeleton-chip" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line short" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return <div className="card error-card">Could not load the feed: {error}</div>;
  }

  if (!posts.length) return <EmptyState onTrigger={onTrigger} busy={busy} cadence={cadence} state={state} />;

  return (
    <div className="feed">
      {posts.map((p) => (
        <PostCard key={p.id} post={p} isNew={newIds.has(p.id)} />
      ))}
    </div>
  );
}
