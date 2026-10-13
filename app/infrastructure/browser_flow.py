"""Short-lived, untrusted browser observations for the public portfolio monitor.

Only fixed metadata is retained. The random publisher key is a write capability:
readers receive its hash, never a reusable capability. These observations never
enter evaluation progress, accounting, authentication or the worker's run state.
"""
from __future__ import annotations

from hashlib import sha256
import json
import math
import re
import time


TTL_SECONDS = 600
STALE_SECONDS = 60
MAX_SOURCES = 200
MAX_EVENTS = 100
MAX_STATES = 64
INDEX = 'careerlens:browser-flow:sources'
PREFIX = 'careerlens:browser-flow:source:'
IDENTIFIER = re.compile(r'^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$')
EVENT_ID = re.compile(r'^event-[0-9]{1,15}$')
NODES = frozenset({
    'visit', 'auth', 'resume', 'role', 'posting', 'api_auth', 'api_resume',
    'api_jobs', 'api_evaluation', 'api_report', 'report', 'signup', 'logout',
    'session', 'cancel', 'history', 'dashboard', 'evaluate', 'api_signup',
    'api_session', 'api_cancel', 'api_dashboard', 'api_convert', 'input_check',
    'local_data', 'notice', 'api_guest_service', 'api_guest_analysis',
    'api_guest_claim', 'api_guest_reports', 'report_lock', 'guest_claim',
    'result_delivery', 'guest_cleanup',
})
STATES = frozenset({'pending', 'running', 'complete', 'failed', 'cancelled', 'partial',
                    'blocked', 'waiting', 'expired', 'cleared', 'empty', 'ready',
                    'guest', 'member', 'logout'})
TERMINAL = STATES - {'pending', 'running', 'waiting'}
KINDS = frozenset({'action', 'request', 'navigation', 'progress', 'session'})
METHODS = frozenset({'GET', 'POST', 'PUT', 'PATCH', 'DELETE'})
RATE_SCRIPT = """
for i=1,3 do
  local used = tonumber(redis.call('GET', KEYS[i]) or '0')
  if used >= tonumber(ARGV[i]) then return 0 end
end
for i=1,3 do
  local used = redis.call('INCR', KEYS[i])
  if used == 1 then redis.call('EXPIRE', KEYS[i], 60) end
end
return 1
"""


class FlowInputError(ValueError):
    """Contains only a public enum code, never rejected input values."""
    def __init__(self, code='invalid_flow_metadata', status=422):
        self.code, self.status = code, status
        super().__init__(code)


def number(value, minimum=0, maximum=86400000):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and minimum <= value <= maximum and math.isfinite(value)


def clean_event(value, received_at):
    if not isinstance(value, dict):
        return None
    ident, node, state, kind = (value.get(key) for key in ('id', 'node', 'state', 'kind'))
    if not isinstance(ident, str) or not EVENT_ID.fullmatch(ident):
        return None
    if not all(isinstance(item, str) for item in (node, state, kind)):
        return None
    if node not in NODES or state not in STATES or kind not in KINDS:
        return None
    at = value.get('at')
    # Source TTL governs retention, not event time. A heartbeat must never turn
    # a genuine old action into a new action by replacing its timestamp.
    at = at if number(at, 0, received_at + 30000) else received_at
    result = {'id': ident, 'node': node, 'state': state, 'kind': kind,
              'source': 'observed', 'at': at, 'durationMs': None, 'progress': None}
    if number(value.get('durationMs')):
        result['durationMs'] = value['durationMs']
    if number(value.get('progress'), 0, 100):
        result['progress'] = value['progress']
    if isinstance(value.get('method'), str) and value['method'] in METHODS:
        result['method'] = value['method']
    if kind == 'session' and isinstance(value.get('sessionMode'), str) and value['sessionMode'] in {'guest', 'member'}:
        result['sessionMode'] = value['sessionMode']
    if value.get('execution') == 'guest':
        result['execution'] = 'guest'
    return result


def clean_envelopes(payload, received_at):
    if not isinstance(payload, dict):
        raise FlowInputError()
    stream, raw_publisher, batch = (payload.get(key) for key in ('stream', 'publisher', 'batch'))
    if not all(isinstance(value, str) and IDENTIFIER.fullmatch(value) for value in (stream, raw_publisher)):
        raise FlowInputError()
    if not isinstance(batch, list) or not 1 <= len(batch) <= 25:
        raise FlowInputError()
    publisher = sha256(raw_publisher.lower().replace('-', '').encode()).hexdigest()[:32]
    clean = []
    for envelope in batch:
        if not isinstance(envelope, dict):
            raise FlowInputError()
        revision, kind = envelope.get('revision'), envelope.get('kind')
        if not isinstance(revision, int) or isinstance(revision, bool) or not 0 <= revision <= 9007199254740991:
            raise FlowInputError()
        if kind not in ('event', 'snapshot', 'disconnected'):
            raise FlowInputError()
        item = {'kind': kind, 'revision': revision}
        if kind == 'event':
            event = clean_event(envelope.get('event'), received_at)
            if event is not None:
                item['event'] = event
        if kind == 'snapshot':
            events, states = envelope.get('events', []), envelope.get('states', [])
            if not isinstance(events, list) or len(events) > MAX_EVENTS or not isinstance(states, list) or len(states) > MAX_STATES:
                raise FlowInputError()
            item['events'] = [event for value in events if (event := clean_event(value, received_at)) is not None]
            item['states'] = [event for value in states if (event := clean_event(value, received_at)) is not None]
            session = envelope.get('session')
            item['session'] = {'mode': 'member' if isinstance(session, dict) and session.get('mode') == 'member' else 'guest'}
        clean.append(item)
    return stream.lower(), publisher, clean


def preserve_terminal(previous, incoming):
    if previous and previous['id'] == incoming['id'] and previous['state'] in TERMINAL and incoming['state'] in {'pending', 'running', 'waiting'}:
        return previous
    return incoming


def merge_observations(previous, envelopes, *, stream, publisher, received_at):
    row = dict(previous or {'kind': 'snapshot', 'stream': stream, 'publisher': 'browser:' + publisher,
                           'revision': -1, 'events': [], 'states': [], 'session': {'mode': 'guest'}})
    events = {event['id']: event for event in row['events']}
    states = {event['node']: event for event in row['states']}
    changed = False
    for envelope in envelopes:
        if envelope['revision'] <= row['revision']:
            continue
        changed = True
        row['revision'] = envelope['revision']
        row['connected'] = envelope['kind'] != 'disconnected'
        incoming = envelope.get('events', []) if envelope['kind'] == 'snapshot' else [envelope['event']] if 'event' in envelope else []
        for event in incoming:
            event = preserve_terminal(events.get(event['id']), event)
            # Stable IDs allow pending -> complete updates without duplicate rows.
            events[event['id']] = event
            if envelope['kind'] == 'event':
                states[event['node']] = preserve_terminal(states.get(event['node']), event)
        if envelope['kind'] == 'snapshot':
            # An explicit snapshot also clears states intentionally removed by
            # the browser (new analysis, logout, history clearing).
            states = {event['node']: preserve_terminal(states.get(event['node']),
                      preserve_terminal(events.get(event['id']), event)) for event in envelope['states']}
            row['session'] = envelope['session']
    if changed:
        row['at'] = received_at
    row['events'] = list(events.values())[-MAX_EVENTS:]
    row['states'] = list(states.values())[-MAX_STATES:]
    row['provenance'] = 'browser_reported'
    row['trusted'] = False
    return row, changed


class BrowserFlowStore:
    def __init__(self, client, *, configured=None, clock=time.time):
        self.client = client
        self.configured = bool(client is not None) if configured is None else configured
        self.clock = clock

    def ingest(self, payload, ip_scope='unknown'):
        received_at = int(self.clock() * 1000)
        stream, publisher, envelopes = clean_envelopes(payload, received_at)
        if self.client is None:
            return {'available': False, 'reason': 'flow_unavailable'}
        try:
            from redis.exceptions import WatchError
            digest = sha256(str(ip_scope).encode()).hexdigest()
            prefix = 'careerlens:browser-flow:rate:'
            allowed = self.client.eval(RATE_SCRIPT, 3, prefix + 'source:' + publisher,
                                       prefix + 'ip:' + digest, prefix + 'global', 120, 600, 3000)
            if not allowed:
                return {'available': True, 'accepted': False, 'reason': 'rate_limited', 'retry_after': 60}
            key = PREFIX + publisher
            for _ in range(5):
                try:
                    with self.client.pipeline() as pipe:
                        pipe.watch(key, INDEX)
                        raw = pipe.get(key)
                        previous = json.loads(raw) if raw else None
                        if previous and previous.get('stream') != stream:
                            raise FlowInputError('flow_source_conflict', 409)
                        count = pipe.zcount(INDEX, received_at - TTL_SECONDS * 1000, '+inf')
                        if not previous and count >= MAX_SOURCES:
                            return {'available': True, 'accepted': False, 'reason': 'source_capacity', 'retry_after': 60}
                        row, changed = merge_observations(previous, envelopes, stream=stream,
                                                          publisher=publisher, received_at=received_at)
                        if not changed:
                            return {'available': True, 'accepted': True, 'revision': row['revision'], 'duplicate': True}
                        pipe.multi()
                        pipe.setex(key, TTL_SECONDS, json.dumps(row, separators=(',', ':')))
                        pipe.zadd(INDEX, {publisher: received_at})
                        pipe.zremrangebyscore(INDEX, '-inf', received_at - TTL_SECONDS * 1000)
                        pipe.expire(INDEX, TTL_SECONDS)
                        pipe.execute()
                    return {'available': True, 'accepted': True, 'revision': row['revision']}
                except WatchError:
                    continue
        except FlowInputError:
            raise
        except Exception:
            # Redis URLs, request text and exception bodies are never logged.
            pass
        return {'available': False, 'reason': 'flow_unavailable'}

    def snapshot(self):
        status = {'configured': self.configured, 'connected': False, 'available': False,
                  'source_count': 0, 'ttl_seconds': TTL_SECONDS, 'stale_after_seconds': STALE_SECONDS}
        if self.client is None:
            return [], status
        try:
            now = int(self.clock() * 1000)
            self.client.ping()
            ids = self.client.zrevrangebyscore(INDEX, '+inf', now - TTL_SECONDS * 1000, start=0, num=MAX_SOURCES)
            values = self.client.mget([PREFIX + str(ident) for ident in ids]) if ids else []
            rows = []
            for raw in values:
                if not raw:
                    continue
                value = json.loads(raw)
                if not isinstance(value, dict) or not isinstance(value.get('publisher'), str) or not re.fullmatch(r'browser:[a-f0-9]{32}', value['publisher']):
                    continue
                if not isinstance(value.get('stream'), str) or not IDENTIFIER.fullmatch(value['stream']) or not number(value.get('at'), 0, now + 30000):
                    continue
                session = value.get('session')
                rows.append({'kind': 'snapshot', 'stream': value['stream'], 'publisher': value['publisher'],
                             'revision': value['revision'], 'at': value['at'],
                             'connected': value.get('connected') is True and now - value['at'] <= STALE_SECONDS * 1000,
                             'events': [event for item in value.get('events', [])[-MAX_EVENTS:] if (event := clean_event(item, now)) is not None],
                             'states': [event for item in value.get('states', [])[-MAX_STATES:] if (event := clean_event(item, now)) is not None],
                             'session': {'mode': 'member' if isinstance(session, dict) and session.get('mode') == 'member' else 'guest'},
                             'provenance': 'browser_reported', 'trusted': False})
            status.update(connected=True, available=True, source_count=len(rows))
            return rows, status
        except Exception:
            return [], status
