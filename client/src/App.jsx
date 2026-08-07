import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api';
import Header from './components/Header';
import Feed from './components/Feed';
import StatusPanel from './components/StatusPanel';
import RejectionsPanel from './components/RejectionsPanel';
import AgentSwitcher from './components/AgentSwitcher';
import InitForm from './components/InitForm';

const POLL_MS = 30_000;

const STAGES = [
  'Scanning headlines…',
  'Deduplicating stories across sources…',
  'Evaluating candidates against editorial standards…',
  'Weighing freshness…',
  'Writing…',
];

export default function App() {
  const [agents, setAgents] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [posts, setPosts] = useState([]);
  const [status, setStatus] = useState(null);
  const [rejections, setRejections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showInit, setShowInit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(null);
  const [toast, setToast] = useState(null);

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
        setTimeout(() => setNewIds(new Set()), 1200);
      }
      feed.posts.forEach((p) => seenIds.current.add(p.id));

      setPosts(feed.posts);
      setStatus(st);
      setRejections(rej.rejections);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Boot: load agents, select the first one.
  useEffect(() => {
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
  }, [loadAgents]);

  // Switching agents resets the animation baseline.
  useEffect(() => {
    if (!activeId) return;
    seenIds.current = new Set();
    setPosts([]);
    setStatus(null);
    setRejections([]);
    loadAgentData(activeId);
  }, [activeId, loadAgentData]);

  // Poll every 30s so autonomously published posts appear without a refresh.
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
    let i = 0;
    setStage(STAGES[0]);
    const ticker = setInterval(() => {
      i = Math.min(i + 1, STAGES.length - 1);
      setStage(STAGES[i]);
    }, 6000);

    try {
      const result = await api.triggerCycle(activeId);
      await loadAgentData(activeId, { silent: true });
      await loadAgents();
      setToast(
        result.published
          ? `Published: ${result.published.title}`
          : `Cycle complete — nothing cleared the bar (${result.rejected} rejected).`
      );
    } catch (err) {
      // Free-tier quota exhaustion is an expected condition, not a crash — say so plainly.
      setToast(err.message);
    } finally {
      clearInterval(ticker);
      setStage(null);
      setBusy(false);
      setTimeout(() => setToast(null), 6000);
    }
  }

  const activeAgent = agents.find((a) => a.agentId === activeId);

  /* --------------------------------- render -------------------------------- */

  return (
    <div className="app">
      <div className="shell">
        <AgentSwitcher
          agents={agents}
          activeId={activeId}
          onSelect={setActiveId}
          onNew={() => setShowInit(true)}
        />

        {(showInit || !agents.length) && (
          <InitForm
            onCreate={handleCreate}
            onCancel={() => setShowInit(false)}
            canCancel={agents.length > 0}
          />
        )}

        {activeId && (
          <>
            <Header agent={activeAgent || status?.persona} status={status} />

            <div className="action-row">
              <button className="btn btn-primary" onClick={handleTrigger} disabled={busy}>
                {busy ? <span className="spinner" /> : '▶'} {busy ? 'Running…' : 'Run a cycle now'}
              </button>
              {stage && <span className="stage">{stage}</span>}
            </div>

            <div className="layout">
              <main className="col-main">
                <Feed
                  posts={posts}
                  loading={loading}
                  error={error}
                  newIds={newIds}
                  onTrigger={handleTrigger}
                  busy={busy}
                />
              </main>
              <aside className="col-side">
                <StatusPanel status={status} />
                <RejectionsPanel rejections={rejections} />
              </aside>
            </div>
          </>
        )}

        <footer className="site-foot">
          Autonomous persona agent · discovers, judges, and publishes on its own schedule
        </footer>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
