import assert from 'node:assert/strict';
import test from 'node:test';
import { runEnvelope, browserEnvelope, createAdminFlowMonitor } from '../../src/features/activity-flow/admin-transport.js';
import { createLiveFlowSources } from '../../src/features/activity-flow/live-sources.js';

const run = (digit, status = 'running') => ({ run_id: `${digit.repeat(8)}-1111-4111-8111-111111111111`, source: 'member',
  status, progress_percent: 20, updated_at: '2026-10-13T01:00:00Z',
  events: [{ stage: 'indexing', status: 'running', progress_percent: 20, created_at: '2026-10-13T01:00:00Z' }],
  email: 'private@example.test', resume: 'PRIVATE_DOCUMENT', token: 'SECRET',
});

const browser = (events = []) => ({ kind: 'snapshot', stream: '1234567890abcdef1234567890abcdef',
  publisher: 'browser:' + 'a'.repeat(32), revision: 1, at: 1000, connected: true,
  events, states: events, session: { mode: 'member' },
});
const action = (id, at, node = 'resume') => ({ id, at, node, state: 'complete', source: 'observed', kind: 'action' });

test('browser snapshots preserve identity and connection while rejecting private fields and claimed server stages', () => {
  const value = browserEnvelope({ ...browser([action('one', 1), { ...action('fake-worker', 2, 'analysis'), source: 'backend' },
    { ...action('fake-parse', 3, 'parse_resume'), source: 'backend' }, { ...action('fake-store', 4, 'storage_ack'), source: 'backend' }]),
    connected: false, secret: 'PRIVATE', session: { mode: 'member', email: 'PRIVATE' } }, 9);
  assert.equal(value.stream, browser().stream);
  assert.equal(value.publisher, browser().publisher);
  assert.equal(value.revision, 9);
  assert.equal(value.connected, false);
  assert.equal(value.provenance, 'browser_reported');
  assert.deepEqual(value.events.map((event) => event.id), ['one']);
  assert.equal(value.events[0].source, 'observed');
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|email|secret/);
  assert.equal(browserEnvelope({ ...browser(), publisher: 'worker:' + 'a'.repeat(32) }, 1), null);
});

test('combined polling delivers only fresh deltas, not bootstrap, repeated heartbeats or reconnect history', async () => {
  const pending = new Map(), envelopes = [], statuses = []; let next = 0, round = 0;
  const monitor = createAdminFlowMonitor({ schedule: (fn) => { pending.set(++next, fn); return next; }, unschedule: (id) => pending.delete(id),
    request: async () => {
      round++;
      if (round === 4) throw new Error('Synthetic outage');
      return { runs: [run('1')], generated_at: new Date(round * 1000).toISOString(), redis: { connected: true },
        browser_sources: round === 6 ? [] : [{ ...browser(round < 3 ? [action('one', 100)] : [action('one', 100), action('two', 300)]), at: round * 1000 }] };
    },
    onEnvelope: (value, metadata) => envelopes.push({ value, metadata }), onStatus: (value) => statuses.push(value),
  });
  monitor.start();
  try {
    await monitor.poll();
    assert.equal(envelopes.length, 2);
    assert.ok(envelopes.every(({ metadata }) => metadata.snapshot && metadata.liveEvents.length === 0));
    assert.equal(statuses.at(-1).runSources, 1);
    assert.equal(statuses.at(-1).browserSources, 1);
    await monitor.poll();
    assert.equal(envelopes.at(-1).metadata.liveEvents.length, 0, 'heartbeat does not manufacture a user action');
    await monitor.poll();
    assert.deepEqual(envelopes.at(-1).metadata.liveEvents.map((event) => event.id), ['two']);
    assert.equal(envelopes.at(-1).metadata.snapshot, false);
    await monitor.poll(); await monitor.poll();
    assert.equal(envelopes.at(-1).metadata.snapshot, true);
    assert.equal(envelopes.at(-1).metadata.liveEvents.length, 0, 'recovered history is never replayed');
    await monitor.poll();
    assert.equal(envelopes.at(-1).value.kind, 'disconnected');
    assert.equal(envelopes.at(-1).value.stream, browser().stream, 'hashed public publisher is not the stream ID');
  } finally { monitor.dispose(); }
  assert.equal(pending.size, 0);
});

test('automatic server selection follows new real work, ignores old snapshot heartbeats, and honors a manual pin', () => {
  const sources = createLiveFlowSources({ central: true, now: () => 100000 });
  const envelope = (digit, status, at, revision = 1) => runEnvelope({ ...run(digit, status),
    created_at: new Date(at).toISOString(), updated_at: new Date(at).toISOString(), events: [] }, revision, 100000);
  const failed = envelope('1', 'failed', 2000), active = envelope('2', 'running', 1000);
  sources.receive(failed, { bootstrap: true }); sources.receive(active, { bootstrap: true });
  assert.equal(sources.snapshot().key, active.publisher, 'active work wins over a newer historical failure at startup');
  const fresh = envelope('3', 'running', 3000, 2);
  sources.receive(fresh);
  assert.equal(sources.snapshot().key, fresh.publisher);
  sources.receive({ ...failed, revision: 2, at: 110000 });
  sources.receive({ ...active, revision: 2, at: 110000 });
  assert.equal(sources.snapshot().key, fresh.publisher, 'unchanged old rows cannot rotate the selection on each poll');
  sources.select(active.publisher);
  sources.receive(envelope('3', 'running', 4000, 3));
  assert.equal(sources.snapshot().key, active.publisher);
  sources.select('auto');
  assert.equal(sources.snapshot().key, fresh.publisher);
});

test('browser heartbeats and background API polling do not steal auto selection from real user actions', () => {
  const sources = createLiveFlowSources({ central: true, now: () => 100000 });
  const first = browserEnvelope(browser([action('first', 100)]), 1);
  sources.receive(first, { bootstrap: true });
  const second = browserEnvelope({ ...browser([action('second', 200)]), publisher: 'browser:' + 'b'.repeat(32), at: 2000 }, 2);
  sources.receive(second);
  assert.equal(sources.snapshot().key, second.publisher);
  sources.receive({ ...first, revision: 3, at: 3000, activity_at: 3000 });
  assert.equal(sources.snapshot().key, second.publisher);
  sources.receive(browserEnvelope({ ...browser([action('first', 100), { ...action('poll', 400, 'api_jobs'), kind: 'request' }]), at: 4000 }, 4));
  assert.equal(sources.snapshot().key, second.publisher);
  sources.receive(browserEnvelope({ ...browser([action('next-user-action', 500)]), at: 5000 }, 5));
  assert.equal(sources.snapshot().key, first.publisher);
});
test('three independent active runs remain separate with only allowlisted metadata', () => {
  const sources = createLiveFlowSources({ central: true });
  for (const digit of ['1', '2', '3']) {
    const envelope = runEnvelope(run(digit), 1);
    assert.doesNotMatch(JSON.stringify(envelope), /PRIVATE|SECRET|email|token|resume/);
    sources.receive(envelope);
  }
  assert.equal(sources.options().length, 3);
  for (const item of sources.options()) {
    const selected = sources.select(item.key);
    assert.equal(selected.states.find((item) => item.node === 'analysis').state, 'running');
    assert.ok(selected.events.every((event) => event.id.startsWith(selected.stream)));
  }
});

test('reopening the monitor prefers latest user activity, not latest heartbeat or background request', () => {
  const sources = createLiveFlowSources({ central: true, now: () => 100000 });
  const recent = browserEnvelope({ ...browser([action('recent', 300)]), at: 1000 }, 1);
  const older = browserEnvelope({ ...browser([action('older', 100), { ...action('poll', 900, 'api_jobs'), kind: 'request' }]),
    publisher: 'browser:' + 'b'.repeat(32), at: 9000 }, 1);
  assert.equal(recent.activity_at, 300);
  assert.equal(older.activity_at, 100);
  sources.receive(recent, { bootstrap: true });
  sources.receive(older, { bootstrap: true });
  assert.equal(sources.snapshot().key, recent.publisher);
});
test('terminal run removes unfinished active highlights without inventing successes', () => {
  const failed = runEnvelope(run('1', 'failed'), 1);
  assert.deepEqual(failed.states.map((event) => [event.node, event.state]), [['analysis', 'failed']]);
  assert.equal(failed.events[0].state, 'running');
  assert.equal(runEnvelope({ ...run('1'), run_id: '<script>' }, 1), null);
});

test('terminal status uses recorded completion time rather than later snapshot updates', () => {
  const completed = '2026-10-13T01:00:05Z';
  const envelope = runEnvelope({ ...run('1', 'failed'), completed_at: completed,
    updated_at: '2026-10-13T02:00:00Z' }, 1, Date.parse('2026-10-13T03:00:00Z'));
  assert.equal(envelope.events.at(-1).at, Date.parse(completed));
  assert.equal(envelope.events[0].at, Date.parse('2026-10-13T01:00:00Z'));
});
test('snapshot transport recovers through DB fallback and stops on disposal', async () => {
  const pending = new Map(); let next = 0, calls = 0;
  const statuses = [], envelopes = [];
  const monitor = createAdminFlowMonitor({ schedule: (fn) => { pending.set(++next, fn); return next; }, unschedule: (id) => pending.delete(id),
    request: async (path) => { assert.equal(path, '/admin/activity-flow'); calls++; return { runs: [run('1')], counts: { running: 1 }, redis: { connected: calls > 1 } }; },
    onStatus: (status) => statuses.push(status), onEnvelope: (envelope) => envelopes.push(envelope),
  });
  monitor.start(); await monitor.poll(); await monitor.poll();
  assert.deepEqual(statuses.map((status) => status.scope), ['database', 'shared']);
  assert.equal(envelopes.length, 2);
  assert.ok(envelopes[1].revision > envelopes[0].revision);
  monitor.dispose(); await monitor.poll();
  assert.equal(calls, 2); assert.equal(pending.size, 0);
});
