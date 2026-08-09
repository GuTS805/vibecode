import { createClient } from '@supabase/supabase-js';

/**
 * Vite only exposes env vars prefixed VITE_ to client code, and bakes them into the built
 * bundle at build time — so unlike the backend's SUPABASE_SERVICE_ROLE_KEY, these two values
 * are not secret. The anon key is designed to be public; it can only do what Supabase's own
 * auth rules allow, and this app uses Supabase for authentication only; no Supabase table is
 * ever queried with it.
 */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const authConfigured = Boolean(url && anonKey);

/**
 * Null when unconfigured rather than throwing, so the app can render a clear "sign-in isn't
 * set up yet" state instead of a blank crashed page — the same convention the backend
 * providers (Groq, Pollinations, Twitter, Bluesky) use for their own missing credentials.
 */
export const supabase = authConfigured
  ? createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;
