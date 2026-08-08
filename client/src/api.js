/** Same-origin in production (Express serves this bundle); Vite proxies /api in dev. */
async function req(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export const listAgents = () => req('/api/agents');
/** The personas defined in src/persona.json — powers the picker in the init form. */
export const listPersonas = () => req('/api/personas');
export const initAgent = (name, domain) =>
  req('/api/agent/init', { method: 'POST', body: JSON.stringify({ persona: { name, domain } }) });
export const getFeed = (agentId) => req(`/api/agent/feed?agentId=${encodeURIComponent(agentId)}`);
export const getStatus = (agentId) => req(`/api/agent/status?agentId=${encodeURIComponent(agentId)}`);
export const getRejections = (agentId) => req(`/api/agent/rejections?agentId=${encodeURIComponent(agentId)}`);
/** The resolved persona config driving every prompt — powers the Persona tab. */
export const getPersona = (agentId) => req(`/api/agent/persona?agentId=${encodeURIComponent(agentId)}`);
export const triggerCycle = (agentId) =>
  req(`/api/agent/trigger?agentId=${encodeURIComponent(agentId)}`, { method: 'POST' });

/** Manual control over the autonomous loop. `stop` is final and closes the 48h window. */
const lifecycle = (action) => (agentId) =>
  req(`/api/agent/${action}?agentId=${encodeURIComponent(agentId)}`, { method: 'POST' });

export const pauseAgent = lifecycle('pause');
export const resumeAgent = lifecycle('resume');
export const stopAgent = lifecycle('stop');

/** "2h ago" style relative timestamps. */
export function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

/** "in ~2h" for the next scheduled cycle. */
export function untilTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const mins = Math.round((then - Date.now()) / 60000);
  if (mins <= 0) return 'due now';
  if (mins < 60) return `~${mins}m`;
  return `~${(mins / 60).toFixed(1)}h`;
}

/** Precise "4h 12m 09s" countdown — the ticking one, which reads as alive. */
export function countdown(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  let secs = Math.floor((then - Date.now()) / 1000);
  if (secs <= 0) return 'due now';
  const h = Math.floor(secs / 3600);
  secs -= h * 3600;
  const m = Math.floor(secs / 60);
  const s = secs - m * 60;
  return h > 0
    ? `${h}h ${String(m).padStart(2, '0')}m`
    : m > 0
      ? `${m}m ${String(s).padStart(2, '0')}s`
      : `${s}s`;
}

/**
 * Each persona gets its own accent, keyed off its beat.
 *
 * With six agents running side by side, colour is the fastest way to tell whose feed you
 * are looking at — faster than reading the name in the header every time you switch. The
 * returned key sets `data-accent`, and the stylesheet maps it to a hue.
 */
const ACCENTS = [
  [/secur|threat|hack|cyber|ai\b|llm|machine|tech/, 'security'],
  [/histor|archaeo|archiv|ancient/, 'history'],
  [/geo|cartograph|map|urban|climate/, 'geography'],
  [/politic|policy|govern|election|civic/, 'politics'],
  [/sport|athlet|football|soccer|basketball/, 'sports'],
  [/music|audio|record|sound/, 'music'],
];

export function personaAccent(domain = '') {
  const d = String(domain).toLowerCase();
  for (const [re, key] of ACCENTS) if (re.test(d)) return key;
  return 'default';
}

/** Initials for the persona monogram, e.g. "Ada" -> "A". */
export const monogram = (name = '') =>
  String(name)
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase() || '?';
