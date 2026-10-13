import asyncio
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
from types import SimpleNamespace

import fakeredis
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.api.v1.routes.api import router
from app.infrastructure.browser_flow import BrowserFlowStore, FlowInputError, PREFIX
from app.infrastructure.realtime import RealtimeMonitor
import app.infrastructure.browser_flow as browser_flow_module


@pytest.fixture
def store():
    clock = [1700000000.0]
    service = BrowserFlowStore(fakeredis.FakeRedis(decode_responses=True), clock=lambda: clock[0])
    service.test_clock = clock
    return service


def event(state='pending', *, ident='event-1', node='resume'):
    return {'id': ident, 'node': node, 'state': state, 'kind': 'request', 'source': 'backend',
            'at': 1700000000000, 'method': 'POST'}


def payload(publisher='a' * 32, *, revision=1, value=None):
    return {'stream': 'b' * 32, 'publisher': publisher,
            'batch': [{'kind': 'event', 'revision': revision, 'event': value or event()}],
            'client_dropped': 0}


def test_three_publishers_remain_separate_and_public_hash_cannot_overwrite_source(store):
    publishers = [f'{number:032x}' for number in range(1, 4)]
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda ident: store.ingest(payload(ident)), publishers))
    assert all(result['accepted'] for result in results)
    sources, status = store.snapshot()
    assert status['connected'] and status['source_count'] == 3
    public_names = {row['publisher'] for row in sources}
    assert public_names == {'browser:' + sha256(ident.encode()).hexdigest()[:32] for ident in publishers}
    assert not any(ident in json.dumps(sources) for ident in publishers)
    exposed_hash = sources[0]['publisher'].removeprefix('browser:')
    store.ingest(payload(exposed_hash, revision=50, value=event('failed')))
    sources, _ = store.snapshot()
    assert len(sources) == 4
    assert all(row['events'][0]['state'] == 'pending' for row in sources if row['publisher'] in public_names)


def test_same_pending_event_can_complete_once_and_cannot_be_revived_by_late_batches(store):
    store.ingest(payload())
    store.ingest(payload(revision=3, value=event('complete')))
    duplicate = store.ingest(payload(revision=2, value=event('pending')))
    assert duplicate['duplicate']
    store.ingest(payload(revision=4, value=event('pending')))
    row = store.snapshot()[0][0]
    assert len(row['events']) == 1
    assert row['events'][0]['state'] == row['states'][0]['state'] == 'complete'
    # A genuinely new request has a new event ID and may be pending again.
    store.ingest(payload(revision=5, value=event('pending', ident='event-2')))
    assert store.snapshot()[0][0]['states'][0]['state'] == 'pending'


def test_snapshot_keeps_latest_node_states_and_ignores_untrusted_fields_and_engine_nodes(store):
    private = 'PRIVATE-RESUME-EMAIL-APIKEY'
    body = payload()
    body['resume_text'] = private
    body['batch'] = [{'kind': 'snapshot', 'revision': 1,
                      'session': {'mode': 'member', 'email': private, 'token': private},
                      'events': [{**event('complete'), 'error': private, 'payload': private},
                                 event('complete', ident='event-2', node='database'),
                                 event('complete', ident='event-3', node='domain_a'),
                                 event('complete', ident='event-4', node='storage_ack')],
                      'states': [event('complete')]}]
    assert store.ingest(body)['accepted']
    row = store.snapshot()[0][0]
    serialized = json.dumps(row)
    assert private not in serialized and 'database' not in serialized and 'domain_a' not in serialized
    assert row['events'][0]['source'] == 'observed'
    assert row['provenance'] == 'browser_reported' and row['trusted'] is False
    assert row['session'] == {'mode': 'member'}
    raw = store.client.get(PREFIX + row['publisher'].removeprefix('browser:'))
    assert private not in raw


def test_heartbeat_and_disconnection_use_server_time_and_sources_expire(store):
    store.ingest(payload())
    store.test_clock[0] += 61
    assert store.snapshot()[0][0]['connected'] is False
    heartbeat = payload(revision=2)
    heartbeat['batch'] = [{'kind': 'snapshot', 'revision': 2, 'at': 1,
                           'events': [], 'states': [event()], 'session': {'mode': 'guest'}}]
    store.ingest(heartbeat)
    current = store.snapshot()[0][0]
    assert current['connected'] is True and current['at'] == int(store.test_clock[0] * 1000)
    disconnected = payload(revision=3)
    disconnected['batch'] = [{'kind': 'disconnected', 'revision': 3}]
    store.ingest(disconnected)
    assert store.snapshot()[0][0]['connected'] is False
    store.test_clock[0] += 601
    assert store.snapshot()[0] == []


def test_heartbeats_after_ten_minutes_preserve_old_event_times(store):
    observed = event('complete')
    original_time = observed['at']
    store.ingest(payload(value=observed))
    for revision in range(2, 37):
        store.test_clock[0] += 20
        heartbeat = {**payload(), 'batch': [{'kind': 'snapshot', 'revision': revision,
                     'events': [observed], 'states': [observed], 'session': {'mode': 'guest'}}]}
        assert store.ingest(heartbeat)['accepted']
    current = store.snapshot()[0][0]
    assert current['connected'] is True
    assert current['at'] - original_time > 600000
    assert current['events'][0]['at'] == current['states'][0]['at'] == original_time


def test_source_limit_rate_cap_and_redis_failure_are_explicit(store, monkeypatch):
    for revision in range(1, 121):
        assert store.ingest(payload(revision=revision))['accepted']
    denied = store.ingest(payload(revision=121))
    assert denied['accepted'] is False and denied['reason'] == 'rate_limited'
    def unavailable(*_args):
        raise ConnectionError('private redis connection')
    monkeypatch.setattr(store.client, 'eval', unavailable)
    assert store.ingest(payload()) == {'available': False, 'reason': 'flow_unavailable'}
    monkeypatch.setattr(store.client, 'ping', unavailable)
    sources, status = store.snapshot()
    assert sources == [] and status['available'] is False


def test_source_capacity_is_bounded_and_existing_source_can_still_send_heartbeat(store, monkeypatch):
    monkeypatch.setattr(browser_flow_module, 'MAX_SOURCES', 3)
    for number in range(3):
        assert store.ingest(payload(f'{number:032x}'))['accepted']
    refused = store.ingest(payload('f' * 32))
    assert refused['reason'] == 'source_capacity' and refused['accepted'] is False
    assert store.ingest(payload('0' * 32, revision=2))['accepted']
    assert len(store.snapshot()[0]) == 3


def test_nested_invalid_optional_fields_and_large_numeric_input_never_enter_storage(store):
    malformed = {**event(), 'method': {'secret': 'PRIVATE'}, 'sessionMode': ['PRIVATE'],
                 'durationMs': 10**1000, 'progress': float('nan')}
    assert store.ingest(payload(value=malformed))['accepted']
    stored = store.snapshot()[0][0]['events'][0]
    assert 'method' not in stored and 'sessionMode' not in stored
    assert stored['durationMs'] is None and stored['progress'] is None


@pytest.mark.parametrize('invalid', [None, {'batch': []}, payload(publisher='email@example.com'),
                                    {**payload(), 'batch': [payload()['batch'][0]] * 26},
                                    {**payload(), 'batch': [{'kind': 'snapshot', 'revision': 1, 'states': [event()] * 65}]}])
def test_invalid_metadata_is_rejected_without_echoing_input(store, invalid):
    with pytest.raises(FlowInputError) as caught:
        store.ingest(invalid)
    assert str(caught.value) == 'invalid_flow_metadata'


def test_flow_route_bounds_chunked_body_and_does_not_expose_errors(store):
    app = FastAPI()
    app.state.realtime = SimpleNamespace(browser_flow=store)
    app.include_router(router)
    with TestClient(app) as client:
        accepted = client.post('/api/v1/flow/events', json=payload())
        assert accepted.status_code == 202 and accepted.json()['accepted']
        huge = client.post('/api/v1/flow/events', content=iter([b'a' * 40000, b'b' * 40000]),
                           headers={'Content-Type': 'application/json'})
        assert huge.status_code == 413
        invalid = client.post('/api/v1/flow/events', json=payload(publisher='PRIVATE-input'))
        assert invalid.status_code == 422 and 'PRIVATE' not in invalid.text
        assert client.post('/api/v1/flow/events', content='hello').status_code == 415


@pytest.mark.asyncio
async def test_admin_snapshot_includes_browser_sources_without_synthetic_worker_runs():
    class EmptyDB:
        async def select(self, *_args, **_kwargs):
            return []
    client = fakeredis.FakeRedis(decode_responses=True)
    monitor = RealtimeMonitor(SimpleNamespace(redis_url=''), client=client)
    await asyncio.to_thread(monitor.browser_flow.ingest, payload())
    result = await monitor.snapshot(EmptyDB())
    assert result['runs'] == []
    assert result['counts']['running'] == 0
    assert len(result['browser_sources']) == 1
    assert result['browser_status']['connected'] is True
