import { relativeTime, untilTime } from '../api';

export default function StatusPanel({ status }) {
  if (!status) {
    return (
      <section className="card panel">
        <h2 className="panel-title">Status</h2>
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line short" />
      </section>
    );
  }

  const { accepted, rejected, topicsEvaluated } = status;
  const acceptPct = topicsEvaluated ? (accepted / topicsEvaluated) * 100 : 0;

  return (
    <section className="card panel">
      <h2 className="panel-title">Status</h2>

      <dl className="stat-grid">
        <div className="stat">
          <dt>Active since</dt>
          <dd>{relativeTime(status.initializedAt)}</dd>
        </div>
        <div className="stat">
          <dt>Topics evaluated</dt>
          <dd>{topicsEvaluated}</dd>
        </div>
        <div className="stat">
          <dt>Next check</dt>
          <dd>{status.cycleRunningNow ? 'running now' : untilTime(status.nextCycleAt)}</dd>
        </div>
        <div className="stat">
          <dt>Last cycle</dt>
          <dd>{status.lastCycleAt ? relativeTime(status.lastCycleAt) : '—'}</dd>
        </div>
      </dl>

      <div className="ratio">
        <div className="ratio-head">
          <span>
            <strong>{accepted}</strong> published
          </span>
          <span className="muted">
            <strong>{rejected}</strong> rejected
          </span>
        </div>
        <div
          className="ratio-bar"
          role="img"
          aria-label={`${accepted} published of ${topicsEvaluated} evaluated`}
        >
          <div className="ratio-fill" style={{ width: `${acceptPct}%` }} />
        </div>
        <p className="ratio-caption">
          {topicsEvaluated
            ? `${acceptPct.toFixed(0)}% acceptance — the persona rejects most of what it sees.`
            : 'No topics evaluated yet.'}
        </p>
      </div>

      <footer className="panel-foot">
        <span>cadence {status.cycleCadence}</span>
        <span>·</span>
        <span>model {status.model}</span>
      </footer>
    </section>
  );
}
