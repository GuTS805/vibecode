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
export default function Header({ agent, status, tick }) {
  const live = status?.autonomyActive;
  const running = status?.cycleRunningNow;
  // `tick` is unused directly — it exists so the parent's 1s timer re-renders the countdown.
  void tick;

  const next = status?.nextCycleAt ? countdown(status.nextCycleAt) : null;

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
          <span className={`state-pill ${running ? 'state-run' : live ? 'state-live' : 'state-off'}`}>
            <span className="state-dot" />
            {running ? 'cycle running' : live ? 'autonomous' : 'window closed'}
          </span>

          <dl className="live-facts">
            <div>
              <dt>Next cycle</dt>
              <dd className="tabular">{running ? 'now' : next || '—'}</dd>
            </div>
            <div>
              <dt>Last cycle</dt>
              <dd>{status.lastCycleAt ? relativeTime(status.lastCycleAt) : 'not yet'}</dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}
