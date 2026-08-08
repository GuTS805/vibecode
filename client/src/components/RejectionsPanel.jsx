import { relativeTime } from '../api';

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Colour the score by how close it came, so near-misses read differently from no-hopers. */
function scoreClass(score) {
  if (score == null) return 'score-none';
  if (score >= 60) return 'score-near';
  if (score >= 30) return 'score-mid';
  return 'score-low';
}

/**
 * Rejected candidates.
 *
 * This was previously a collapsed drawer in the sidebar, which buried the single strongest
 * piece of evidence that the agent exercises judgment rather than republishing whatever it
 * finds. It is now a first-class tab: every declined story with the standard it failed and
 * the score it earned.
 */
export default function RejectionsPanel({ rejections, acceptanceRate, evaluated }) {
  if (!rejections.length) {
    return (
      <div className="card empty-state">
        <div className="empty-glyph" aria-hidden="true">
          ⌀
        </div>
        <h3>Nothing rejected yet</h3>
        <p>
          Once a cycle runs, every candidate this persona declines is logged here with the
          editorial standard it failed and the score it earned.
        </p>
      </div>
    );
  }

  const pct = Math.round((acceptanceRate ?? 0) * 100);

  return (
    <div className="rejections">
      <div className="card rejections-summary">
        <p className="rejections-lede">
          <strong>{rejections.length}</strong> of <strong>{evaluated}</strong> candidates declined
          — a <strong>{pct}%</strong> acceptance rate.
        </p>
        <p className="muted small">
          A low number here is the system working. Each entry names the standard the story
          failed: beat fit, substance, novelty against what this persona already published,
          source credibility, or timeliness.
        </p>
      </div>

      <ul className="rejection-list">
        {rejections.map((r) => {
          const host = r.url ? hostOf(r.url) : null;
          return (
            <li key={r.id} className="card rejection-card">
              <div className="rejection-head">
                <p className="rejection-topic">{r.topic}</p>
                {r.score != null && (
                  <span className={`score-badge ${scoreClass(r.score)}`} title="Overall editorial score">
                    {r.score}
                  </span>
                )}
              </div>
              <p className="rejection-reason">{r.reason}</p>
              <div className="rejection-foot">
                <time dateTime={r.createdAt}>{relativeTime(r.createdAt)}</time>
                {host && (
                  <>
                    <span aria-hidden="true">·</span>
                    <a href={r.url} target="_blank" rel="noopener noreferrer">
                      {host}
                    </a>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
