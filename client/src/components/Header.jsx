import { countdown, monogram, relativeTime } from '../api';

/** One-line description of what this beat is for, shown under the name. */
function taglineFor(domain = '') {
  const d = domain.toLowerCase();
  const table = [
    [/secur|threat|hack|cyber/, 'Watching the attack surface so you do not have to.'],
    [/histor|archaeo|archiv/, 'New findings, not anniversaries.'],
    [/geo|cartograph|map|urban/, 'Why the line is where it is.'],
    [/politic|policy|govern|election/, 'Process and mechanism, not personalities.'],
    [/sport|athlet/, 'What the numbers say about what you saw.'],
    [/music|audio|record/, 'Who owns the master, and who gets paid.'],
    [/research|science|paper|model/, 'Separating results from press releases.'],
  ];
  for (const [re, tagline] of table) if (re.test(d)) return tagline;
  return 'Reading the feed so you do not have to.';
}

/**
 * Persona identity block.
 *
 * The live state is the point of this component: the whole claim of the project is that the
 * agent keeps working unattended, so the next cycle is shown as a running countdown rather
 * than a static timestamp. A number that visibly ticks down is the difference between
 * "this says it is autonomous" and "you can watch it being autonomous".
 */
/**
 * The pill reflects manual state first: a paused agent is not "window closed".
 *
 * Pausing while a cycle is in flight gets its own label. That cycle holds an open request to
 * the model provider and is allowed to finish, so reporting a flat "paused" while work is
 * visibly still happening would look like the pause had failed.
 */
function stateLabel(status) {
  const running = status?.cycleRunningNow;
  if (status?.state === 'stopped') {
    return running
      ? { cls: 'state-paused', text: 'stopping' }
      : { cls: 'state-off', text: 'stopped' };
  }
  if (status?.state === 'paused') {
    return running
      ? { cls: 'state-paused', text: 'pausing' }
      : { cls: 'state-paused', text: 'paused' };
  }
  if (running) return { cls: 'state-run', text: 'cycle running' };
  if (status?.autonomyActive) return { cls: 'state-live', text: 'autonomous' };
  return { cls: 'state-off', text: 'window closed' };
}

export default function Header({ agent, status, tick, onPause, onResume, onStop, onDelete, lifecycleBusy }) {
  const running = status?.cycleRunningNow;
  // `tick` is unused directly — it exists so the parent's 1s timer re-renders the countdown.
  void tick;

  const next = status?.nextCycleAt ? countdown(status.nextCycleAt) : null;
  const pill = stateLabel(status);
  const state = status?.state || 'active';

  return (
    <section className="persona-header">
      <div className="persona-id">
        <div className="persona-mono" aria-hidden="true">
          {monogram(agent?.name)}
        </div>
        <div className="persona-titles">
          <h1>{agent?.name || 'No agent'}</h1>
          <p className="persona-beat-line">{agent?.domain || 'Initialize an agent to begin'}</p>
          <p className="persona-tagline">{taglineFor(agent?.domain)}</p>
        </div>
      </div>

      {status && (
        <div className="persona-live">
          <span className={`state-pill ${pill.cls}`}>
            <span className="state-dot" />
            {pill.text}
          </span>

          <dl className="live-facts">
            <div>
              <dt>Next cycle</dt>
              <dd className="tabular">
                {state !== 'active'
                  ? running
                    ? 'finishing'
                    : state === 'paused'
                      ? 'paused'
                      : '—'
                  : running
                    ? 'now'
                    : next || '—'}
              </dd>
            </div>
            <div>
              <dt>Last cycle</dt>
              <dd>{status.lastCycleAt ? relativeTime(status.lastCycleAt) : 'not yet'}</dd>
            </div>
          </dl>

          {/* An agent that publishes unattended for 48 hours needs a visible off switch,
              not just an API call. Stop is separated and styled as destructive because it
              cannot be undone. */}
          {state !== 'stopped' && (
            <div className="lifecycle-controls">
              {state === 'paused' ? (
                <button className="btn btn-sm btn-primary" onClick={onResume} disabled={lifecycleBusy}>
                  ▶ Resume
                </button>
              ) : (
                <button className="btn btn-sm btn-ghost" onClick={onPause} disabled={lifecycleBusy}>
                  ❚❚ Pause
                </button>
              )}
              <button className="btn btn-sm btn-danger" onClick={onStop} disabled={lifecycleBusy}>
                ■ Stop
              </button>
            </div>
          )}

          {/* Stopped agents pile up in the switcher with no further use — resume is closed
              off deliberately (see setLifecycle). Delete is the way to actually clear one
              out, offered only here since it is destructive and only valid on a dead end. */}
          {state === 'stopped' && (
            <div className="lifecycle-controls">
              <button className="btn btn-sm btn-danger" onClick={onDelete} disabled={lifecycleBusy}>
                🗑 Delete
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
