/**
 * Supabase-backed authentication.
 *
 * Supabase is used for identity only — who is logged in — never as the data store. Agents,
 * posts, and rejections stay in the same SQLite file they always have; Supabase Auth's job
 * ends at handing back a verified user id, which `isOwnedBy()` in db.js uses to scope every
 * query. No Supabase table, no Row Level Security policy, is involved anywhere in this app.
 *
 * Token verification calls Supabase's own `auth.getUser()` rather than decoding the JWT
 * locally. That is one network round trip per authenticated request, which is a deliberate
 * trade against writing and maintaining JWKS fetching, key rotation, and signature
 * verification by hand for an app whose request volume is dashboard clicks, not a high-QPS
 * API — correctness here is worth more than the few milliseconds saved.
 */
import { createClient } from '@supabase/supabase-js';

let client = null;

export function isConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function getClient() {
  if (!isConfigured()) {
    const e = new Error(
      'Auth is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — see .env.example.'
    );
    e.code = 'AUTH_NOT_CONFIGURED';
    throw e;
  }
  if (!client) {
    // service_role bypasses RLS and must never reach the frontend — it exists only here, read
    // from the server's own environment, and is used solely to ask "whose token is this."
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return client;
}

/**
 * Create an already-confirmed account via the admin API, bypassing Supabase's normal signup
 * flow entirely.
 *
 * The normal flow — `supabase.auth.signUp()` from the browser — sends a confirmation email
 * before a session is issued, and free-tier Supabase rate-limits its own email sender tightly
 * enough that real signups failed with `over_email_send_rate_limit` while building this.
 * There is also no verified-email requirement this app actually needs: it is not a public
 * service where proving mailbox ownership matters, and every account is isolated from every
 * other one by `user_id` regardless of how it was created. So signup goes through the backend
 * instead — `admin.createUser({ email_confirm: true })` creates an account that can sign in
 * immediately, with zero emails sent and the free-tier rate limit never in the picture.
 */
export async function signUp(email, password) {
  const { data, error } = await getClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) {
    // Supabase's admin API reports a duplicate email as its own error rather than the
    // generic-looking "check your email" the public signUp() endpoint gives for the same
    // case — surfaced here as a normal 409, not swallowed into a vague success state.
    const e = new Error(
      /already.*registered|already exists/i.test(error.message)
        ? 'An account with that email already exists. Sign in instead.'
        : error.message
    );
    e.code = /already.*registered|already exists/i.test(error.message) ? 'EMAIL_TAKEN' : 'SIGNUP_FAILED';
    e.retryable = false;
    throw e;
  }
  return data.user;
}

/**
 * Express middleware: every /api/agent/* route needs a real, verified user before it does
 * anything, since every one of those routes now reads or writes data scoped to a user_id.
 * Missing config surfaces as 503 (an operator problem — fix the deployment), a missing or
 * invalid token as 401 (a caller problem — log in).
 */
export async function requireAuth(req, res, next) {
  if (!isConfigured()) {
    return res.status(503).json({
      error: 'Sign-in is not set up on this server yet.',
      code: 'AUTH_NOT_CONFIGURED',
    });
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Sign in to continue.', code: 'NO_TOKEN' });
  }

  try {
    const { data, error } = await getClient().auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Your session has expired. Sign in again.', code: 'INVALID_TOKEN' });
    }
    req.userId = data.user.id;
    req.userEmail = data.user.email || null;
    next();
  } catch (err) {
    console.error('[auth] verification failed:', err.message);
    res.status(503).json({ error: 'Could not verify sign-in right now. Try again shortly.', code: 'AUTH_ERROR' });
  }
}
