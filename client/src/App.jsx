import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api';
import { supabase, authConfigured } from './supabaseClient';
import Auth from './components/Auth';
import TopBar from './components/TopBar';
import Header from './components/Header';
import Feed from './components/Feed';
import StatusPanel from './components/StatusPanel';
import SocialPanel from './components/SocialPanel';
import RejectionsPanel from './components/RejectionsPanel';
import PersonaPanel from './components/PersonaPanel';
import InitForm from './components/InitForm';

const POLL_MS = 30_000;

const STAGES = [
  'Searching for candidate stories…',
  'Verifying sources…',
  'Judging each candidate against editorial standards…',
  'Checking against what it already published…',
  'Writing…',
];

/** Quota and configuration failures persist until resolved; they are not toast material. */
const STICKY_ERROR = /quota|rate limit|api key|not available|billing/i;

function useTheme() {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('pa-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('pa-theme', theme);
  }, [theme]);

  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

/**
 * Session bootstrap and live sync.
 *
 * Every agent now belongs to a user, so nothing in the dashboard can load until we know who is
 * asking. `getSession()` answers that once, synchronously-ish, from Supabase's local storage
 * cache (fast — no network round trip for the common case of a returning, already-signed-in
 * visitor); `onAuthStateChange` then keeps it current for sign-in, sign-out, and the token
 * refreshes Supabase does automatically in the background. `api.setAuthToken` is updated in
 * the same callback so every request already carries the right bearer token by the time
 * anything tries to fetch data — there is no window where a stale or missing token could
 * cause a flash of 401s.
 */
function useSession() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(!authConfigured);

  useEffect(() => {
    if (!authConfigured) return undefined;

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      api.setAuthToken(data.session?.access_token || null);
      setReady(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      api.setAuthToken(next?.access_token || null);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  return { session, ready };
}

export default function App() {
  const { session, ready } = useSession();
  const [agents, setAgents] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [posts, setPosts] = useState([]);
  const [status, setStatus] = useState(null);
  const [rejections, setRejections] = useState([]);
  const [rejectionMeta, setRejectionMeta] = useState({ evaluated: 0, acceptanceRate: 0 });
  const [persona, setPersona] = useState(null);
  const [tab, setTab] = useState('posts');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [banner, setBanner] = useState(null);
  const [showInit, setShowInit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [socialBusy, setSocialBusy] = useState({ twitter: false, bluesky: false });
  const [stage, setStage] = useState(null);
  const [toast, setToast] = useState(null);
  const [theme, toggleTheme] = useTheme();

  // Drives the live countdown without re-fetching. One state bump a second is cheap and
  // makes the autonomy visible instead of merely stated.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Ids already seen, so only genuinely new cards animate in.
  const seenIds = useRef(new Set());
  const [newIds, setNewIds] = useState(new Set());

  /* ------------------------------ data loading ------------------------------ */

  const loadAgents = useCallback(async () => {
    const { agents } = await api.listAgents();
    setAgents(agents);
    return agents;
  }, []);

  const loadAgentData = useCallback(async (agentId, { silent = false } = {}) => {
    if (!agentId) return;
    if (!silent) setLoading(true);
    try {
      const [feed, st, rej] = await Promise.all([
        api.getFeed(agentId),
        api.getStatus(agentId),
        api.getRejections(agentId),
      ]);

      const fresh = feed.posts.filter((p) => !seenIds.current.has(p.id)).map((p) => p.id);
      if (fresh.length && seenIds.current.size) {
        setNewIds(new Set(fresh));
        setTimeout(() => setNewIds(new Set()), 1400);
      }
      feed.posts.forEach((p) => seenIds.current.add(p.id));

      setPosts(feed.posts);
      setStatus(st);
      setRejections(rej.rejections);
      setRejectionMeta({ evaluated: rej.evaluated, acceptanceRate: rej.acceptanceRate });
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // The persona config changes only when the agent does, so it is fetched separately from
  // the 30s poll rather than re-requested every tick.
  useEffect(() => {
    if (!activeId) return;
    setPersona(null);
    api
      .getPersona(activeId)
      .then(({ persona }) => setPersona(persona))
      .catch(() => setPersona(null));
  }, [activeId]);

  // Load this user's agents once a session exists, and reset every piece of per-agent state
  // on sign-out — otherwise a second account signing in on the same tab would flash the
  // previous user's cached feed for a moment before the new data arrived.
  useEffect(() => {
    if (!session) {
      setAgents([]);
      setActiveId(null);
      setPosts([]);
      setStatus(null);
      setRejections([]);
      setShowInit(false);
      seenIds.current = new Set();
      return;
    }
    (async () => {
      try {
        const list = await loadAgents();
        if (list.length) setActiveId(list[0].agentId);
        else {
          setShowInit(true);
          setLoading(false);
        }
      } catch (err) {
        setError(err.message);
        setLoading(false);
      }
    })();
  }, [session, loadAgents]);

  // Switching agents resets the animation baseline.
  useEffect(() => {
    if (!activeId) return;
    seenIds.current = new Set();
    setPosts([]);
    setStatus(null);
    setRejections([]);
    setTab('posts');
    loadAgentData(activeId);
  }, [activeId, loadAgentData]);

  // Poll so autonomously published posts appear without a refresh.
  useEffect(() => {
    if (!activeId) return undefined;
    const id = setInterval(() => loadAgentData(activeId, { silent: true }), POLL_MS);
    return () => clearInterval(id);
  }, [activeId, loadAgentData]);

  /* -------------------------------- actions -------------------------------- */

  async function handleCreate(name, domain) {
    const { agentId } = await api.initAgent(name, domain);
    await loadAgents();
    setActiveId(agentId);
    setShowInit(false);
    setToast(`${name} is live — publishing autonomously for 48h.`);
    setTimeout(() => setToast(null), 5000);
  }

  async function handleTrigger() {
    if (!activeId || busy) return;
    setBusy(true);
    setBanner(null);
    let i = 0;
    setStage(STAGES[0]);
    const ticker = setInterval(() => {
      i = Math.min(i + 1, STAGES.length - 1);
      setStage(STAGES[i]);
    }, 7000);

    try {
      const result = await api.triggerCycle(activeId);
      await loadAgentData(activeId, { silent: true });
      await loadAgents();
      const published = result.published || [];
      setToast(
        published.length === 1
          ? `Published: ${published[0].title}`
          : published.length > 1
            ? `Published ${published.length} posts.`
            : `Cycle complete — nothing cleared the bar (${result.rejected} rejected).`
      );
      // Nothing published is a normal editorial outcome; point at the evidence for it.
      if (!published.length && result.rejected > 0) setTab('rejected');
      setTimeout(() => setToast(null), 6000);
    } catch (err) {
      // A quota wall is a standing condition, not a momentary blip — it must not disappear
      // after six seconds while the user is still looking for the cause.
      if (STICKY_ERROR.test(err.message)) setBanner(err.message);
      else {
        setToast(err.message);
        setTimeout(() => setToast(null), 6000);
      }
    } finally {
      clearInterval(ticker);
      setStage(null);
      setBusy(false);
    }
  }

  /**
   * Pause / resume / stop.
   *
   * Stop is confirmed because it cannot be undone — it closes the autonomy window, and the
   * only way back is a fresh agent. Pause and resume are cheap and reversible, so they act
   * immediately without a prompt.
   */
  async function handleLifecycle(action) {
    if (!activeId || lifecycleBusy) return;

    const name = activeAgent?.name || 'This agent';
    if (
      action === 'stop' &&
      !window.confirm(
        `Stop ${name} permanently?\n\nIts autonomy window closes and it cannot be resumed — ` +
          `you would need to initialize a new agent. Published posts are kept.\n\n` +
          `To pause it temporarily instead, cancel and use Pause.`
      )
    ) {
      return;
    }

    setLifecycleBusy(true);
    try {
      const fn = { pause: api.pauseAgent, resume: api.resumeAgent, stop: api.stopAgent }[action];
      const result = await fn(activeId);
      await Promise.all([loadAgentData(activeId, { silent: true }), loadAgents()]);
      setToast(
        result.unchanged
          ? `${name} is already ${result.state}.`
          : action === 'resume'
            ? `${name} resumed — next cycle scheduled.`
            : action === 'pause'
              ? `${name} paused.${result.cycleStillFinishing ? ' A cycle already running will finish first.' : ''}`
              : `${name} stopped.`
      );
      setTimeout(() => setToast(null), 6000);
    } catch (err) {
      setToast(err.message);
      setTimeout(() => setToast(null), 6000);
    } finally {
      setLifecycleBusy(false);
    }
  }

  /**
   * Social posting toggle and manual "post now", shared across X and Bluesky. Independent of
   * handleLifecycle: an agent's write cycle and its promotion to any given network are
   * separate switches (see scheduler.js), so a failure or busy-state in one network must not
   * block the agent's writing, its other network, or vice versa — hence per-network busy
   * flags rather than one shared boolean.
   */
  async function handleSocial(network, action) {
    if (!activeId || socialBusy[network]) return;
    setSocialBusy((b) => ({ ...b, [network]: true }));
    const label = network === 'twitter' ? 'Tweeting' : 'Bluesky posting';
    const verb = network === 'twitter' ? 'Tweeted' : 'Posted';
    try {
      const fns = { enable: api.enableSocial, disable: api.disableSocial, postNow: api.postNowSocial };
      const result = await fns[action](network, activeId);
      await loadAgentData(activeId, { silent: true });
      if (action === 'enable') setToast(`${label} enabled — the oldest unposted post goes out within a minute.`);
      else if (action === 'disable') setToast(`${label} disabled.`);
      else if (action === 'postNow') {
        setToast(
          result.posted
            ? `${result.dryRun ? '[Dry run] ' : ''}${verb}.`
            : result.reason === 'nothing-to-tweet'
              ? 'Nothing to post yet — no unposted posts.'
              : `Could not post: ${result.error || result.reason}`
        );
      }
      setTimeout(() => setToast(null), 6000);
    } catch (err) {
      setToast(err.message);
      setTimeout(() => setToast(null), 6000);
    } finally {
      setSocialBusy((b) => ({ ...b, [network]: false }));
    }
  }

  const handleSignOut = useCallback(() => {
    supabase.auth.signOut();
  }, []);

  const activeAgent = agents.find((a) => a.agentId === activeId);
  const agentLifecycle = status?.state || activeAgent?.state || 'active';
  const isActive = agentLifecycle === 'active';
  const accent = useMemo(
    () => api.personaAccent(activeAgent?.domain || status?.persona?.domain),
    [activeAgent, status]
  );

  const TABS = [
    ['posts', 'Posts', posts.length],
    ['rejected', 'Rejected', rejections.length],
    ['persona', 'Persona', null],
  ];

  /* --------------------------------- render -------------------------------- */

  // Nothing renders until we know whether there is a cached session — otherwise a returning,
  // already-signed-in visitor would see the login form flash for a moment before their
  // session loads, which reads as the app forgetting them.
  if (!ready) return <div className="app auth-boot" aria-hidden="true" />;
  if (!session) return <Auth />;

  return (
    <div className="app" data-accent={accent}>
      <TopBar
        agents={agents}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => setShowInit(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
        userEmail={session.user?.email}
        onSignOut={handleSignOut}
      />

      <div className="shell">
        {banner && (
          <div className="banner" role="status">
            <span className="banner-icon" aria-hidden="true">
              !
            </span>
            <p>{banner}</p>
            <button className="banner-close" onClick={() => setBanner(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}

        {(showInit || !agents.length) && (
          <InitForm
            onCreate={handleCreate}
            onCancel={() => setShowInit(false)}
            canCancel={agents.length > 0}
            existingAgents={agents}
          />
        )}

        {activeId && (
          <>
            <Header
              agent={activeAgent || status?.persona}
              status={status}
              tick={tick}
              onPause={() => handleLifecycle('pause')}
              onResume={() => handleLifecycle('resume')}
              onStop={() => handleLifecycle('stop')}
              lifecycleBusy={lifecycleBusy}
            />

            <div className="action-row">
              <button
                className="btn btn-primary"
                onClick={handleTrigger}
                disabled={busy || !isActive}
                title={isActive ? undefined : `${activeAgent?.name || 'This agent'} is ${agentLifecycle}`}
              >
                {busy ? <span className="spinner" /> : <span aria-hidden="true">▶</span>}
                {busy ? 'Running…' : 'Run a cycle now'}
              </button>
              {stage && <span className="stage">{stage}</span>}
              {!stage && (
                <span className="action-note muted small">
                  {agentLifecycle === 'paused'
                    ? 'Paused — it will not publish until you resume it.'
                    : agentLifecycle === 'stopped'
                      ? 'Stopped — this agent has finished for good.'
                      : 'Optional — it publishes on its own schedule regardless.'}
                </span>
              )}
            </div>

            <div className="layout">
              <main className="col-main">
                <nav className="tabs" role="tablist" aria-label="Agent views">
                  {TABS.map(([key, label, count]) => (
                    <button
                      key={key}
                      role="tab"
                      aria-selected={tab === key}
                      className={`tab-btn${tab === key ? ' tab-btn-active' : ''}`}
                      onClick={() => setTab(key)}
                    >
                      {label}
                      {count !== null && <span className="tab-btn-count">{count}</span>}
                    </button>
                  ))}
                </nav>

                <div role="tabpanel">
                  {tab === 'posts' && (
                    <Feed
                      state={agentLifecycle}
                      posts={posts}
                      loading={loading}
                      error={error}
                      newIds={newIds}
                      onTrigger={handleTrigger}
                      busy={busy}
                      cadence={status?.cycleCadence}
                      author={{
                        name: activeAgent?.name || status?.persona?.name,
                        role: persona?.role,
                        domain: activeAgent?.domain || status?.persona?.domain,
                      }}
                    />
                  )}
                  {tab === 'rejected' && (
                    <RejectionsPanel
                      rejections={rejections}
                      evaluated={rejectionMeta.evaluated}
                      acceptanceRate={rejectionMeta.acceptanceRate}
                    />
                  )}
                  {tab === 'persona' && <PersonaPanel persona={persona} />}
                </div>
              </main>

              <aside className="col-side">
                <StatusPanel status={status} tick={tick} />
                <SocialPanel
                  network="twitter"
                  status={status?.twitter}
                  onEnable={() => handleSocial('twitter', 'enable')}
                  onDisable={() => handleSocial('twitter', 'disable')}
                  onPostNow={() => handleSocial('twitter', 'postNow')}
                  busy={socialBusy.twitter}
                  canAct={isActive}
                />
                <SocialPanel
                  network="bluesky"
                  status={status?.bluesky}
                  onEnable={() => handleSocial('bluesky', 'enable')}
                  onDisable={() => handleSocial('bluesky', 'disable')}
                  onPostNow={() => handleSocial('bluesky', 'postNow')}
                  busy={socialBusy.bluesky}
                  canAct={isActive}
                />
              </aside>
            </div>
          </>
        )}

        <footer className="site-foot">
          Autonomous persona agents · discover, judge, and publish on their own schedule
        </footer>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
