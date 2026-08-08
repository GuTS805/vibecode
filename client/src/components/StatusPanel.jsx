import { countdown, relativeTime } from '../api';

/**
 * Live activity for the selected agent.
 *
 * Reads as a monitor rather than a stat dump: the countdown ticks, the acceptance ratio is
 * the headline number (it is the evidence of judgment), and the provider/cadence detail sits
 * at the bottom where it does not compete.
 */
export default function StatusPanel({ status, tick }) {
  void tick; // parent's 1s timer drives the countdown re-render

  if (!status) {
    return (
      <section className="card panel">
        <h2 className="panel-title">Activity</h2>
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line short" />
      </section>
    );
  }

  const { accepted, rejected, topicsEvaluated, cycleRunningNow } = status;
  const acceptPct = topicsEvaluated ? (accepted / topicsEvaluated) * 100 : 0;
  const next = status.nextCycleAt ? countdown(status.nextCycleAt) : null;

  const expiresMs = new Date(status.autonomyExpiresAt).getTime() - Date.now();
  const hoursLeft = Math.max(0, expiresMs / 3_600_000);

  return (
    <section className="card panel activity">
      <h2 className="panel-title">Activity</h2>

      <div className={`next-cycle${cycleRunningNow ? ' next-cycle-running' : ''}`}>
        <span className="next-label">{cycleRunningNow ? 'Cycle running' : 'Next cycle in'}</span>
        <span className="next-value tabular">{cycleRunningNow ? '···' : next || '—'}</span>
      </div>

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
            ? `${acceptPct.toFixed(0)}% acceptance — most of what it finds does not clear the bar.`
            : 'No topics evaluated yet.'}
        </p>
      </div>

      <dl className="stat-grid">
        <div className="stat">
          <dt>Active since</dt>
          <dd>{relativeTime(status.initializedAt)}</dd>
        </div>
        <div className="stat">
          <dt>Last cycle</dt>
          <dd>{status.lastCycleAt ? relativeTime(status.lastCycleAt) : '—'}</dd>
        </div>
        <div className="stat">
          <dt>Evaluated</dt>
          <dd>{topicsEvaluated}</dd>
        </div>
        <div className="stat">
          <dt>Window left</dt>
          <dd>{hoursLeft > 0 ? `${hoursLeft.toFixed(0)}h` : 'closed'}</dd>
        </div>
      </dl>

      <footer className="panel-foot">
        <span title="How far apart cycles run">{status.cycleCadence}</span>
        <span className="foot-sep" aria-hidden="true">
          ·
        </span>
        <span title="Active model">{status.model}</span>
        {status.imageProvider && status.imageProvider !== 'disabled' && (
          <>
            <span className="foot-sep" aria-hidden="true">
              ·
            </span>
            <span title="Image provider">art: {status.imageProvider}</span>
          </>
        )}
      </footer>
    </section>
  );
}
