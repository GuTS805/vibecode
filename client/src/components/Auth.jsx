import { useState } from 'react';
import { supabase, authConfigured } from '../supabaseClient';

/**
 * The six personas that ship in persona.json, as decoration for the sign-in hero.
 *
 * Hardcoded rather than fetched: this renders before anyone is authenticated, and adding a
 * network round trip to the first paint of the login screen — for a row of coloured circles —
 * would trade real latency for nothing. If the roster in persona.json changes, this is a
 * cosmetic list to update, not a source of truth anything depends on.
 */
const ROSTER = [
  ['A', 'security'],
  ['T', 'history'],
  ['N', 'geography'],
  ['E', 'politics'],
  ['D', 'sports'],
  ['W', 'music'],
];

/**
 * Sign in / sign up gate.
 *
 * Rendered instead of the dashboard whenever there is no verified session — every agent
 * belongs to exactly one Supabase user now, so there is no meaningful "logged-out" view of
 * the app to fall back to. One form covers both modes rather than two routes, since the
 * fields are identical and the only difference is whether an account gets created first.
 */
export default function Auth() {
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!authConfigured) {
    return (
      <div className="auth-shell">
        <div className="card auth-card">
          <h1 className="auth-title">Sign-in is not set up</h1>
          <p className="muted small">
            This deployment is missing <code>VITE_SUPABASE_URL</code> and{' '}
            <code>VITE_SUPABASE_ANON_KEY</code>. Add them to <code>client/.env.local</code> (or the
            hosting provider's environment settings) and rebuild.
          </p>
        </div>
      </div>
    );
  }

  /**
   * Both call the backend rather than the Supabase client directly.
   *
   * Signup: `supabase.auth.signUp()` needs a confirmed inbox before it issues a session, and
   * free-tier Supabase rate-limits its own confirmation-email sender tightly enough that real
   * signups failed outright while building this. `/api/auth/signup` creates the account
   * already confirmed.
   *
   * Sign-in: routed through the backend too, so it can self-heal an account that ended up
   * unconfirmed for any reason — including one created by a browser tab that still had an
   * older frontend bundle loaded from before the signup fix above existed. See `signIn()` in
   * `src/auth.js`. The backend hands back a real Supabase session pair, installed here with
   * `setSession()` so everything downstream behaves exactly as if `signInWithPassword()` had
   * been called directly.
   */
  async function backendAuth(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signup') {
        await backendAuth('/api/auth/signup', { email, password });
      }
      const { accessToken, refreshToken } = await backendAuth('/api/auth/signin', { email, password });
      const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
      if (error) throw error;
      // No further action needed — App.jsx's onAuthStateChange listener picks up the new
      // session and swaps this form out for the dashboard.
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function pick(next) {
    setMode(next);
    setError(null);
  }

  return (
    <div className="auth-shell">
      <div className="auth-layout">
        {/* Explains what is behind the form. Hidden entirely below 860px — on a phone this
            would just be a screen of copy between the visitor and the password field. */}
        <div className="auth-hero">
          <div className="auth-hero-mark">
            <span className="brand-mark" aria-hidden="true" />
            <span>Persona Agents</span>
          </div>

          <h1 className="auth-hero-title">
            Six writers who never <em>stop</em> reading the news.
          </h1>

          <p className="auth-hero-sub">
            Each one has a beat, a voice, and an opinion about what is worth publishing. Give one
            a single API call and it runs itself for the next 48 hours.
          </p>

          <ul className="auth-hero-points">
            <li>
              <span>
                <strong>Discovers and judges on its own.</strong> Most of what it finds gets
                rejected — and it tells you why.
              </span>
            </li>
            <li>
              <span>
                <strong>Writes in character, with artwork.</strong> Illustrated posts on a
                schedule it keeps by itself.
              </span>
            </li>
            <li>
              <span>
                <strong>Publishes to Bluesky and X.</strong> Opt in per agent, on its own cadence.
              </span>
            </li>
          </ul>

          <div className="auth-roster">
            <div className="auth-roster-avatars" aria-hidden="true">
              {ROSTER.map(([initial, accent]) => (
                <span key={accent} data-accent={accent}>
                  {initial}
                </span>
              ))}
            </div>
            <span className="auth-roster-note">Ada, Tobias, Neve, Ellis, Dario and Wren are waiting.</span>
          </div>
        </div>

        <form className="card auth-card" onSubmit={submit}>
          <h1 className="auth-title">{mode === 'signin' ? 'Welcome back' : 'Create your account'}</h1>
          <p className="muted small auth-sub">
            {mode === 'signin'
              ? 'Sign in to your agents.'
              : 'Your agents are yours alone — nobody else can see them.'}
          </p>

          {/* Both modes visible at once, rather than one hidden behind a "switch to the other
              one" link. That link is how a returning visitor ends up clicking Sign up on an
              account they already have. */}
          <div className="auth-modes" role="group" aria-label="Sign in or sign up">
            <button
              type="button"
              className={`auth-mode-btn${mode === 'signin' ? ' auth-mode-btn-active' : ''}`}
              onClick={() => pick('signin')}
              aria-pressed={mode === 'signin'}
              disabled={busy}
            >
              Sign in
            </button>
            <button
              type="button"
              className={`auth-mode-btn${mode === 'signup' ? ' auth-mode-btn-active' : ''}`}
              onClick={() => pick('signup')}
              aria-pressed={mode === 'signup'}
              disabled={busy}
            >
              Sign up
            </button>
          </div>

          <label className="auth-field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="you@example.com"
              disabled={busy}
            />
          </label>
          <label className="auth-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              placeholder={mode === 'signin' ? 'Your password' : 'At least 6 characters'}
              disabled={busy}
            />
          </label>

          {error && <p className="form-error">{error}</p>}

          <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>

          <p className="auth-foot">
            {mode === 'signin'
              ? 'No confirmation email — accounts work the moment they are made.'
              : 'No confirmation email needed. You are signed in as soon as this finishes.'}
          </p>
        </form>
      </div>
    </div>
  );
}
