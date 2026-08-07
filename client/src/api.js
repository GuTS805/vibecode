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
export const initAgent = (name, domain) =>
  req('/api/agent/init', { method: 'POST', body: JSON.stringify({ persona: { name, domain } }) });
export const getFeed = (agentId) => req(`/api/agent/feed?agentId=${encodeURIComponent(agentId)}`);
export const getStatus = (agentId) => req(`/api/agent/status?agentId=${encodeURIComponent(agentId)}`);
export const getRejections = (agentId) => req(`/api/agent/rejections?agentId=${encodeURIComponent(agentId)}`);
export const triggerCycle = (agentId) =>
  req(`/api/agent/trigger?agentId=${encodeURIComponent(agentId)}`, { method: 'POST' });

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
