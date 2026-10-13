import { FLOW_NODES, normalizeFlowEvent } from './catalog.js';
import { stageForFlow } from './backend-progress.js';

const requestApi = async (...args) => (await import('../../shared/api/client.js')).api(...args);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminal = new Set(['completed', 'partial', 'failed', 'cancelled']);
const state = (value) => value === 'completed' ? 'complete' : ['queued', 'running', 'partial', 'failed', 'cancelled', 'complete'].includes(value) ? value : null;
const timestamp = (value) => { const result = Date.parse(value); return Number.isFinite(result) ? result : null; };

/** Only server-recorded stages are mapped; missing criterion details stay absent. */
export function runEnvelope(run, revision, now = Date.now()) {
  if (!UUID.test(run?.run_id) || !['member', 'guest'].includes(run.source) || !state(run.status)) return null;
  const publisher = `${run.source === 'guest' ? 'guest' : 'worker'}:${run.run_id}`;
  const events = (Array.isArray(run.events) ? run.events : []).slice(-100).flatMap((row) => {
    const node = FLOW_NODES.has(row?.node) ? row.node : stageForFlow(row?.stage);
    const at = timestamp(row?.created_at);
    const status = state(row?.state || row?.status);
    if (!node || at === null || !status) return [];
    const event = normalizeFlowEvent({ id: `${run.run_id}:${String(row.created_at).slice(0, 40)}:${node}:${row.criterion || ''}`, node,
      state: status, source: 'backend', kind: 'progress', at, progress: row.progress_percent,
      ...(run.source === 'guest' ? { execution: 'guest' } : {}), ...(row.criterion ? { criterion: row.criterion } : {}),
    });
    return event ? [event] : [];
  });
  const at = timestamp((terminal.has(run.status) && run.completed_at) || run.updated_at || run.started_at || run.created_at);
  if (at !== null) events.push(normalizeFlowEvent({ id: `${run.run_id}:status`,
    node: run.status === 'queued' ? 'queue' : 'analysis', state: state(run.status),
    source: 'backend', kind: 'progress', at, progress: run.progress_percent,
    ...(run.source === 'guest' ? { execution: 'guest' } : {}),
  }));
  const clean = events.filter(Boolean);
  const states = new Map(clean.map((event) => [event.node, event]));
  if (terminal.has(run.status)) {
    for (const [node, event] of states) if (node !== 'analysis' && ['running', 'queued'].includes(event.state)) states.delete(node);
  } else if (run.status !== 'queued') states.delete('queue');
  return { kind: 'snapshot', stream: run.run_id, publisher, revision, at: now,
    connected: run.stale !== true, events: clean, states: [...states.values()], session: { mode: run.source },
  };
}

/** Poll the durable server snapshot. Redis supplies cross-process live events;
 * the API reports its own fallback explicitly when Redis is unavailable. */
export function createAdminFlowMonitor({ request = requestApi, schedule = setTimeout,
  unschedule = clearTimeout, onEnvelope = () => {}, onReset = () => {}, onStatus = () => {}, interval = 1500 } = {}) {
  let paused = true, disposed = false, pending = null, controller = null, revision = 0, failures = 0, generation = 0;
  let status = { state: 'connecting', scope: null, sources: 0, received: 0, gaps: 0, counts: {} };
  const seen = new Set();
  const emit = (change) => { status = { ...status, ...change }; onStatus({ ...status }); };
  function plan(delay = interval) {
    if (!disposed && !paused && pending === null && !controller) pending = schedule(() => { pending = null; void poll(); }, delay);
  }
  async function poll() {
    if (disposed || paused || controller) return;
    controller = new AbortController(); const current = controller, currentGeneration = generation;
    const deadline = schedule(() => current.abort(), 15000);
    try {
      const payload = await request('/admin/activity-flow', { signal: current.signal });
      if (disposed || paused || current.signal.aborted || currentGeneration !== generation) return;
      if (!Array.isArray(payload?.runs)) throw new Error('Invalid activity snapshot');
      revision++;
      const present = new Set();
      for (const run of payload.runs.slice(0, 500)) {
        const envelope = runEnvelope(run, revision);
        if (!envelope) continue;
        present.add(envelope.publisher); seen.add(envelope.publisher);
        onEnvelope(envelope, { snapshot: true });
      }
      for (const publisher of seen) if (!present.has(publisher)) {
        onEnvelope({ kind: 'disconnected', stream: publisher.split(':')[1], publisher, revision, at: Date.now() }, { snapshot: true });
        seen.delete(publisher);
      }
      failures = 0;
      emit({ state: 'connected', scope: payload.redis?.connected === true ? 'shared' : 'database',
        sources: present.size, counts: payload.counts || {}, redis: payload.redis || {}, generated_at: payload.generated_at });
    } catch (error) {
      if (disposed || paused || currentGeneration !== generation) return;
      if ([401, 403].includes(error?.status)) { paused = true; emit({ state: 'unauthorized' }); }
      else { failures++; emit({ state: 'retrying' }); }
    } finally {
      unschedule(deadline);
      if (controller === current) controller = null;
      plan(failures ? Math.min(30000, interval * 2 ** Math.min(failures, 4)) : interval);
    }
  }
  return {
    start() { if (!disposed) { paused = false; plan(0); } },
    pause() { paused = true; generation++; if (pending !== null) unschedule(pending); pending = null; controller?.abort(); },
    restart() { this.pause(); controller = null; seen.clear(); onReset(); this.start(); },
    poll, status: () => ({ ...status }),
    dispose() { this.pause(); disposed = true; },
  };
}
