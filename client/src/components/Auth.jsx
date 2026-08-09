import { useState } from 'react';
import { supabase, authConfigured } from '../supabaseClient';

/**
 * Sign in / sign up gate.
 *
 * Rendered instead of the dashboard whenever there is no verified session — every agent
 * belongs to exactly one Supabase user now, so there is no meaningful "logged-out" view of
 * the app to fall back to. One form toggles between the two modes rather than being two
 * routes, since the fields are identical and the only difference is which Supabase call runs.
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

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signup') {
        // Routed through the backend rather than supabase.auth.signUp() directly: that call
        // needs a confirmed inbox before it issues a session, and free-tier Supabase
        // rate-limits its own confirmation-email sender tightly enough that real signups
        // failed outright while building this. /api/auth/signup creates the account already
        // confirmed, so signing in immediately after works with no email step at all.
        const res = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `Sign-up failed (${res.status})`);

        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // No further action needed — App.jsx's onAuthStateChange listener picks up the new
        // session and swaps this form out for the dashboard.
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="card auth-card" onSubmit={submit}>
        <h1 className="auth-title">Persona Agents</h1>
        <p className="muted small auth-sub">
          {mode === 'signin' ? 'Sign in to your agents.' : 'Create an account — your agents are yours alone.'}
        </p>

        <label className="auth-field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
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
            disabled={busy}
          />
        </label>

        {error && <p className="form-error">{error}</p>}

        <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Sign up'}
        </button>

        <button
          type="button"
          className="btn btn-ghost auth-switch"
          onClick={() => {
            setMode((m) => (m === 'signin' ? 'signup' : 'signin'));
            setError(null);
          }}
          disabled={busy}
        >
          {mode === 'signin' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}
