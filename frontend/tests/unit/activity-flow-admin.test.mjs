import assert from 'node:assert/strict';
import test from 'node:test';
import { runEnvelope, createAdminFlowMonitor } from '../../src/features/activity-flow/admin-transport.js';
import { createLiveFlowSources } from '../../src/features/activity-flow/live-sources.js';

const run = (digit, status = 'running') => ({ run_id: `${digit.repeat(8)}-1111-4111-8111-111111111111`, source: 'member',
  status, progress_percent: 20, updated_at: '2026-10-13T01:00:00Z',
  events: [{ stage: 'indexing', status: 'running', progress_percent: 20, created_at: '2026-10-13T01:00:00Z' }],
  email: 'private@example.test', resume: 'PRIVATE_DOCUMENT', token: 'SECRET',
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
test('terminal run removes unfinished active highlights without inventing successes', () => {
  const failed = runEnvelope(run('1', 'failed'), 1);
  assert.deepEqual(failed.states.map((event) => [event.node, event.state]), [['analysis', 'failed']]);
  assert.equal(failed.events[0].state, 'running');
  assert.equal(runEnvelope({ ...run('1'), run_id: '<script>' }, 1), null);
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
