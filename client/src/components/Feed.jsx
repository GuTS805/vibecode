import PostCard from './PostCard';

function EmptyState({ onTrigger, busy, cadence }) {
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

export default function Feed({ posts, loading, error, newIds, onTrigger, busy, cadence }) {
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

  if (!posts.length) return <EmptyState onTrigger={onTrigger} busy={busy} cadence={cadence} />;

  return (
    <div className="feed">
      {posts.map((p) => (
        <PostCard key={p.id} post={p} isNew={newIds.has(p.id)} />
      ))}
    </div>
  );
}
