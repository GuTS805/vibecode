/** Picks an avatar glyph + tagline from the persona's domain. */
function personaTheme(domain = '') {
  const d = domain.toLowerCase();
  const table = [
    [/secur|threat|hack|cyber/, '🛡️', 'Watching the attack surface so you do not have to.'],
    [/policy|regulat|law|govern|ethic/, '⚖️', 'Reading the rules before they bite.'],
    [/infra|cloud|system|devops|platform/, '🧱', 'Following the plumbing under the hype.'],
    [/research|science|paper|model/, '🔬', 'Separating results from press releases.'],
    [/robot|hardware|chip|silicon/, '🤖', 'Where the atoms meet the models.'],
    [/data|analytic|ml|machine/, '📊', 'Signal first, narrative second.'],
    [/product|startup|business|market/, '🚀', 'What shipped, and whether it matters.'],
  ];
  for (const [re, icon, tagline] of table) if (re.test(d)) return { icon, tagline };
  return { icon: '🧠', tagline: 'Reading the feed so you do not have to.' };
}

export default function Header({ agent, status }) {
  const { icon, tagline } = personaTheme(agent?.domain);
  const live = status?.autonomyActive;

  return (
    <header className="header">
      <div className="header-avatar" aria-hidden="true">{icon}</div>
      <div className="header-text">
        <div className="header-topline">
          <h1>{agent?.name || 'No agent'}</h1>
          {status && (
            <span className={`pill ${live ? 'pill-live' : 'pill-idle'}`}>
              <span className="dot" />
              {live ? 'autonomous' : 'window closed'}
            </span>
          )}
        </div>
        <p className="header-domain">{agent?.domain || 'Initialize an agent to begin'}</p>
        <p className="header-tagline">{tagline}</p>
      </div>
    </header>
  );
}
