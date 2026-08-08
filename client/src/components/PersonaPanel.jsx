/**
 * The persona config, rendered.
 *
 * This is the object every prompt in the pipeline is built from — discovery, judging,
 * writing, and the voice review all read the same block. Showing it in the UI turns the
 * central claim of the project into something checkable: you can read the voice rules and
 * the do-not-cover list, then read the feed and see whether the agent held to them.
 */
export default function PersonaPanel({ persona }) {
  if (!persona) {
    return (
      <div className="card panel">
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line short" />
      </div>
    );
  }

  const voice = persona.voice || {};

  return (
    <div className="persona-doc">
      <section className="card panel">
        <h2 className="panel-title">Who this is</h2>
        <p className="persona-role-line">
          <strong>{persona.name}</strong> · {persona.role}
        </p>
        <p className="persona-bio">{persona.bio}</p>
      </section>

      <section className="card panel">
        <h2 className="panel-title">Voice</h2>
        <dl className="voice-grid">
          {[
            ['Sentence length', voice.sentenceLength],
            ['Formality', voice.formality],
            ['Jargon', voice.jargon],
            ['Humour', voice.humor],
            ['Hedging', voice.hedging],
            ['Structure', voice.structure],
          ]
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
        </dl>
      </section>

      <div className="beat-split">
        <section className="card panel">
          <h2 className="panel-title">Covers</h2>
          <ul className="beat-list">
            {(persona.covers || []).map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </section>

        <section className="card panel">
          <h2 className="panel-title">Never covers</h2>
          <ul className="beat-list beat-list-neg">
            {(persona.avoids || []).map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card panel">
        <h2 className="panel-title">Standing positions</h2>
        <p className="muted small">
          Views this persona returns to when a story genuinely bears on one — and is told not
          to recite when it does not.
        </p>
        <ol className="opinion-list">
          {(persona.recurringOpinions || []).map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ol>
      </section>

      {persona.bannedPhrases?.length > 0 && (
        <section className="card panel">
          <h2 className="panel-title">Never writes</h2>
          <p className="muted small">
            Checked by a deterministic lint before any post is stored. A draft that trips it is
            regenerated once with the violation named.
          </p>
          <div className="banned-row">
            {persona.bannedPhrases.map((p) => (
              <span key={p} className="banned-chip">
                {p}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
