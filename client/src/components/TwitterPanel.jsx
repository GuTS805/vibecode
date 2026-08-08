import { useState } from 'react';
import { countdown, relativeTime } from '../api';

/**
 * X (Twitter) posting control.
 *
 * A toggle rather than a fire-and-forget button, because this is a standing decision — "keep
 * promoting this persona's posts to my account" — not a one-off action, and it needs to be as
 * easy to turn off as on. It lives beside StatusPanel rather than folded into Header: pausing
 * the *agent* and pausing its *tweeting* are independent switches (see scheduler.js), so they
 * get visually separate controls rather than implying one governs the other.
 */
export default function TwitterPanel({ twitter, onEnable, onDisable, onTweetNow, busy, canAct }) {
  const [expanded, setExpanded] = useState(false);

  if (!twitter) {
    return (
      <section className="card panel">
        <h2 className="panel-title">X (Twitter)</h2>
        <div className="skeleton skeleton-line" />
      </section>
    );
  }

  const { configured, dryRun, enabled, nextTweetAt, lastTweetAt, cadence, isTweetingNow } = twitter;

  return (
    <section className="card panel twitter-panel">
      <div className="twitter-head">
        <h2 className="panel-title">X (Twitter)</h2>
        <label className="switch" title={enabled ? 'Disable tweeting' : 'Enable tweeting'}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy || !canAct}
            onChange={(e) => (e.target.checked ? onEnable() : onDisable())}
          />
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
        </label>
      </div>

      {!configured && (
        <p className="twitter-note twitter-note-warn">
          No X credentials set. Add <code>TWITTER_API_KEY</code>, <code>TWITTER_API_SECRET</code>,{' '}
          <code>TWITTER_ACCESS_TOKEN</code>, and <code>TWITTER_ACCESS_SECRET</code> to enable posting.
        </p>
      )}

      {configured && dryRun && (
        <p className="twitter-note twitter-note-dry">
          <strong>Dry run.</strong> Composed tweets are logged and recorded against each post, but
          nothing is actually sent to X. Set <code>TWITTER_DRY_RUN=false</code> once posting is
          confirmed working.
        </p>
      )}

      {enabled ? (
        <>
          <dl className="stat-grid twitter-stats">
            <div className="stat">
              <dt>Next tweet</dt>
              <dd className="tabular">{isTweetingNow ? 'posting…' : nextTweetAt ? countdown(nextTweetAt) : '—'}</dd>
            </div>
            <div className="stat">
              <dt>Last tweet</dt>
              <dd>{lastTweetAt ? relativeTime(lastTweetAt) : 'never'}</dd>
            </div>
          </dl>

          <button
            type="button"
            className="disclosure"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            <span className={`caret${expanded ? ' caret-open' : ''}`} aria-hidden="true">
              ▸
            </span>
            {expanded ? 'Hide details' : 'Tweeting details'}
          </button>
          <div className={`collapsible${expanded ? ' collapsible-open' : ''}`}>
            <div className="collapsible-inner">
              <p className="muted small">
                Promotes the oldest unposted post to X roughly every {cadence}, independent of how
                often this persona writes. Tweets the takeaway plus a source link, never the full
                post.
              </p>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={onTweetNow}
                disabled={busy || !canAct}
              >
                Tweet oldest unposted now
              </button>
            </div>
          </div>
        </>
      ) : (
        <p className="muted small">
          Off — this persona&rsquo;s posts are not promoted to X. Turning it on tweets the oldest
          unposted post within a minute, then roughly every 3–5 hours after that.
        </p>
      )}
    </section>
  );
}
