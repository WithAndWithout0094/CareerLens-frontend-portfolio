"""Redis operational state must remain isolated, private and recoverable."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from types import SimpleNamespace

import fakeredis
import pytest

from app.infrastructure.realtime import INDEX, PREFIX, RealtimeMonitor, safe_event


def make_monitor(client=None):
    return RealtimeMonitor(SimpleNamespace(redis_url='', realtime_ttl_seconds=900),
                           client=client if client is not None else fakeredis.FakeRedis(decode_responses=True))


@pytest.mark.asyncio
async def test_three_concurrent_runs_keep_distinct_progress_and_discard_private_fields():
    monitor = make_monitor()
    await asyncio.gather(*(monitor.publish_run({'id': f'run-{index}', 'user_id': f'user-{index}',
                                                'status': 'running', 'progress_percent': index * 20,
                                                'resume_text': 'PRIVATE RESUME', 'report_text': 'PRIVATE REPORT',
                                                'openai_api_key': 'SECRET', 'failure_reason': 'SECRET PROVIDER URL'})
                           for index in range(3)))
    rows, connected = monitor._cached_runs()
    assert connected
    assert {row['run_id']: row['progress_percent'] for row in rows} == {'run-0': 0, 'run-1': 20, 'run-2': 40}
    assert len({row['user_ref'] for row in rows}) == 3
    raw = ' '.join(monitor._client.mget([PREFIX + f'run-{index}' for index in range(3)]))
    assert 'PRIVATE' not in raw and 'SECRET' not in raw and 'user-0' not in raw
    assert 0 < monitor._client.ttl(PREFIX + 'run-0') <= 900


@pytest.mark.asyncio
async def test_completed_status_and_monotonic_progress_survive_late_callback():
    monitor = make_monitor()
    await monitor.publish_run({'id': 'run-a', 'status': 'completed', 'progress_percent': 100,
                               'current_stage': 'completed'})
    await monitor.publish_run({'id': 'run-a', 'status': 'running', 'progress_percent': 30,
                               'current_stage': 'parsing'}, event={'stage': 'parsing', 'message': 'PRIVATE'})
    row = monitor._cached_runs()[0][0]
    assert row['status'] == 'completed'
    assert row['current_stage'] == 'completed'
    assert row['progress_percent'] == 100
    assert 'message' not in row['events'][0]


class SnapshotDB:
    async def select(self, table, **filters):
        if table == 'progress_events':
            return [{'run_id': 'run-a', 'stage': 'completed', 'status': 'completed',
                     'progress_percent': 100, 'message': 'PRIVATE'}]
        if 'status' in filters:
            return []
        return [{'id': 'run-a', 'user_id': 'owner', 'status': 'completed', 'progress_percent': 100,
                 'current_stage': 'completed', 'created_at': datetime.now(timezone.utc)}]


@pytest.mark.asyncio
async def test_snapshot_uses_persisted_status_after_stale_cache_and_survives_redis_failure(monkeypatch):
    monitor = make_monitor()
    await monitor.publish_run({'id': 'run-a', 'status': 'running', 'progress_percent': 5})
    snapshot = await monitor.snapshot(SnapshotDB())
    assert snapshot['transport'] == 'redis'
    assert snapshot['runs'][0]['status'] == 'completed'
    assert snapshot['runs'][0]['progress_percent'] == 100
    assert snapshot['counts']['completed'] == 1
    assert 'PRIVATE' not in json.dumps(snapshot)
    def disconnected():
        raise ConnectionError('Synthetic Redis outage')
    monkeypatch.setattr(monitor._client, 'ping', disconnected)
    fallback = await monitor.snapshot(SnapshotDB())
    assert fallback['transport'] == 'postgres'
    assert fallback['redis'] == {'configured': True, 'connected': False}
    assert fallback['runs'][0]['status'] == 'completed'


@pytest.mark.asyncio
async def test_guest_observer_requires_overall_completion_and_never_exposes_payload():
    monitor = make_monitor()
    monitor.record_flow('guest-a', 'queue', 'pending', publisher='PRIVATE')
    monitor.record_flow('guest-a', 'analysis', 'running', progress=0)
    monitor.record_flow('guest-a', 'parse_resume', 'complete', resume='PRIVATE')
    row = monitor._cached_runs()[0][0]
    assert row['status'] == 'running'
    assert row['source'] == 'guest'
    assert row['events'][-1]['node'] == 'parse_resume'
    monitor.record_flow('guest-a', 'analysis', 'complete', progress=100)
    final = monitor._cached_runs()[0][0]
    assert final['status'] == 'completed'
    assert final['completed_at']
    assert 'PRIVATE' not in json.dumps(final)
    assert monitor._client.zcard(INDEX) == 1


def test_atomic_budget_caps_simultaneous_reservations_and_deduplicates_retries():
    monitor = make_monitor()
    with ThreadPoolExecutor(max_workers=12) as executor:
        attempts = list(executor.map(lambda index: monitor.reserve_analysis('analyses:global', 3, 86400,
                                                                           idempotency_key=f'input-{index}'),
                                     range(20)))
    accepted = [index for index, result in enumerate(attempts) if result['allowed']]
    assert len(accepted) == 3
    assert all(result['reason'] == 'limit' for result in attempts if not result['allowed'])
    retry = monitor.reserve_analysis('analyses:global', 3, 86400, idempotency_key=f'input-{accepted[0]}')
    assert retry['allowed'] and retry['remaining'] == 0
    assert monitor.reserve_analysis('analyses:global', 3, 86400, idempotency_key='new-input')['allowed'] is False
    assert 0 < retry['retry_after'] <= 86400


def test_configured_redis_budget_fails_closed_during_outage(monkeypatch):
    monitor = make_monitor()
    def unavailable(*_args):
        raise ConnectionError('Do not echo redis://SECRET')
    monkeypatch.setattr(monitor._client, 'eval', unavailable)
    decision = monitor.reserve_analysis('analyses:global', 60, 86400)
    assert decision == {'allowed': False, 'remaining': 0, 'retry_after': 5,
                        'reason': 'unavailable', 'backend': 'redis'}
    assert 'SECRET' not in json.dumps(decision)


def test_unconfigured_local_budget_is_still_bounded_and_thread_safe():
    monitor = RealtimeMonitor(SimpleNamespace(redis_url=''))
    with ThreadPoolExecutor(max_workers=8) as executor:
        attempts = list(executor.map(lambda _: monitor.reserve_analysis('analyses:global', 3, 86400), range(20)))
    assert sum(result['allowed'] for result in attempts) == 3


def test_semantic_nodes_are_derived_without_publishing_messages():
    parsed = safe_event({'stage': 'parsing', 'status': 'running', 'message': '이력서 문서 구조화 완료'})
    assert parsed['node'] == 'parse_resume' and parsed['state'] == 'complete'
    criterion = safe_event({'stage': 'criterion', 'status': 'completed', 'message': 'B2 · 6/12개 항목 검증 및 저장 완료'})
    assert criterion['node'] == 'domain_b' and criterion['criterion'] == 'B2'
    assert 'message' not in parsed and 'message' not in criterion
    assert 'node' not in safe_event({'stage': 'parsing', 'message': 'PRIVATE input'})
