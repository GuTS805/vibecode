import { useState } from 'react';
import { countdown, relativeTime } from '../api';

/** Per-network copy, kept out of the component so adding a third network is data, not JSX. */
export const NETWORKS = {
  twitter: {
    title: 'X (Twitter)',
    verb: 'tweet',
    verbNoun: 'Tweeting',
    pastVerb: 'tweeted',
    credsNote: (
      <>
        No X credentials set. Add <code>TWITTER_API_KEY</code>, <code>TWITTER_API_SECRET</code>,{' '}
        <code>TWITTER_ACCESS_TOKEN</code>, and <code>TWITTER_ACCESS_SECRET</code> to enable posting.
      </>
    ),
    dryRunEnvVar: 'TWITTER_DRY_RUN',
  },
  bluesky: {
    title: 'Bluesky',
    verb: 'post',
    verbNoun: 'Posting',
    pastVerb: 'posted',
    credsNote: (
      <>
        No Bluesky credentials set. Add <code>BLUESKY_HANDLE</code> and{' '}
        <code>BLUESKY_APP_PASSWORD</code> (an app password from Settings &gt; Privacy and
        Security &gt; App Passwords — not the account login password) to enable posting.
      </>
    ),
    dryRunEnvVar: 'BLUESKY_DRY_RUN',
  },
};

/**
 * Promotion control for one social network — X or Bluesky, same shape either way.
 *
 * A toggle rather than a fire-and-forget button, because this is a standing decision — "keep
 * promoting this persona's posts to my account" — not a one-off action, and it needs to be as
 * easy to turn off as on. It lives beside StatusPanel rather than folded into Header: pausing
 * the *agent* and pausing its promotion are independent switches (see scheduler.js), so they
 * get visually separate controls rather than implying one governs the other.
 */
export default function SocialPanel({ network, status, onEnable, onDisable, onPostNow, busy, canAct }) {
  const [expanded, setExpanded] = useState(false);
  const copy = NETWORKS[network];

  if (!status) {
    return (
      <section className="card panel">
        <h2 className="panel-title">{copy.title}</h2>
        <div className="skeleton skeleton-line" />
      </section>
    );
  }

  const { configured, dryRun, enabled, nextTweetAt, lastTweetAt, cadence, isTweetingNow } = status;

  return (
    <section className="card panel twitter-panel">
      <div className="twitter-head">
        <h2 className="panel-title">{copy.title}</h2>
        <label className="switch" title={enabled ? `Disable ${copy.verb}ing` : `Enable ${copy.verb}ing`}>
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

      {!configured && <p className="twitter-note twitter-note-warn">{copy.credsNote}</p>}

      {configured && dryRun && (
        <p className="twitter-note twitter-note-dry">
          <strong>Dry run.</strong> Composed posts are logged and recorded against each post, but
          nothing is actually sent. Set <code>{copy.dryRunEnvVar}=false</code> once posting is
          confirmed working.
        </p>
      )}

      {enabled ? (
        <>
          <dl className="stat-grid twitter-stats">
            <div className="stat">
              <dt>Next {copy.verb}</dt>
              <dd className="tabular">{isTweetingNow ? 'posting…' : nextTweetAt ? countdown(nextTweetAt) : '—'}</dd>
            </div>
            <div className="stat">
              <dt>Last {copy.verb}</dt>
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
            {expanded ? 'Hide details' : `${copy.verbNoun} details`}
          </button>
          <div className={`collapsible${expanded ? ' collapsible-open' : ''}`}>
            <div className="collapsible-inner">
              <p className="muted small">
                Promotes the oldest unposted post roughly every {cadence}, independent of how
                often this persona writes. Uses the takeaway plus a source link, never the full
                post.
              </p>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={onPostNow}
                disabled={busy || !canAct}
              >
                {copy.verbNoun === 'Tweeting' ? 'Tweet' : 'Post'} oldest unposted now
              </button>
            </div>
          </div>
        </>
      ) : (
        <p className="muted small">
          Off — this persona&rsquo;s posts are not promoted to {copy.title}. Turning it on{' '}
          {copy.pastVerb === 'tweeted' ? 'tweets' : 'posts'} the oldest unposted post within a
          minute, then roughly every 3–5 hours after that.
        </p>
      )}
    </section>
  );
}
