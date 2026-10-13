"""Redis-backed operational state; PostgreSQL remains the evaluation authority.

This stream contains only IDs, enum-like stages, percentages and timestamps.
It must never contain resume text, reports, credentials or provider errors.
The synchronous client is shared safely by guest threads and the ASGI worker;
async callers offload it so a cache outage cannot block the event loop.
"""
from __future__ import annotations

import asyncio
from collections import Counter, defaultdict
from datetime import datetime, timezone
from hashlib import sha256
import json
import math
import re
import threading
import time


STATUSES = frozenset({'queued', 'running', 'completed', 'partial', 'failed', 'cancelled'})
TERMINAL = STATUSES - {'queued', 'running'}
SAFE_CODE = re.compile(r'^[a-z][a-z0-9_]{0,63}$')
INDEX = 'careerlens:activity:runs'
PREFIX = 'careerlens:activity:run:'
NODES = frozenset({'queue', 'analysis', 'parse_resume', 'parse_job', 'indexing', 'domain_a', 'domain_b',
                   'domain_c', 'domain_d', 'validation', 'scoring', 'database', 'guest_store'})
FIXED_NODES = {
    ('parsing', '이력서 문서 구조화 시작'): ('parse_resume', 'running'),
    ('parsing', '이력서 문서 구조화 완료'): ('parse_resume', 'complete'),
    ('parsing', '채용공고 구조화 시작'): ('parse_job', 'running'),
    ('parsing', '채용공고 구조화 완료'): ('parse_job', 'complete'),
    ('indexing', '이력서 근거 검색 준비 시작'): ('indexing', 'running'),
    ('indexing', '이력서 근거 검색 준비 완료'): ('indexing', 'complete'),
    ('validation', '전체 평가 결과 교차 검토 시작'): ('validation', 'running'),
    ('validation', '전체 평가 결과 교차 검토 완료'): ('validation', 'complete'),
    ('validation', '최종 점수 계산 시작'): ('scoring', 'running'),
    ('validation', '최종 점수 계산 완료'): ('scoring', 'complete'),
    ('validation', '점수 계산 및 Markdown 보고서 생성 시작'): ('database', 'running'),
    ('validation', '최종 Markdown 보고서 저장 완료'): ('database', 'complete'),
}

# Check and increment in one Redis command, shared across all web processes.
# A dedup key is scoped to this budget and an immutable request fingerprint.
RESERVE_SCRIPT = """
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local ttl = redis.call('TTL', KEYS[1])
if ARGV[3] == '1' and redis.call('EXISTS', KEYS[2]) == 1 then
  return {1, math.max(0, tonumber(ARGV[1]) - used), math.max(1, ttl)}
end
if used >= tonumber(ARGV[1]) then
  return {0, 0, math.max(1, ttl)}
end
used = redis.call('INCR', KEYS[1])
if used == 1 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  ttl = tonumber(ARGV[2])
end
if ARGV[3] == '1' then redis.call('SET', KEYS[2], '1', 'EX', math.max(1, ttl)) end
return {1, math.max(0, tonumber(ARGV[1]) - used), math.max(1, ttl)}
"""


def timestamp(value=None):
    if value is None:
        return datetime.now(timezone.utc).isoformat()
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace('Z', '+00:00')).isoformat()
        except ValueError:
            pass
    return None


def safe_progress(value):
    try:
        result = float(value)
        return min(100, max(0, result)) if math.isfinite(result) else 0
    except (TypeError, ValueError):
        return 0


def safe_event(row):
    stage = str(row.get('stage', row.get('node', 'evaluation')))
    stage = stage if SAFE_CODE.fullmatch(stage) else 'evaluation'
    state = str(row.get('status', row.get('state', 'running')))
    state = {'complete': 'completed', 'pending': 'queued'}.get(state, state)
    event = {'stage': stage, 'status': state if state in STATUSES | {'skipped'} else 'running',
             'progress_percent': safe_progress(row.get('progress_percent', row.get('progress', 0))),
             'created_at': timestamp(row.get('created_at')) or timestamp()}
    node = row.get('node')
    if node in NODES:
        event['node'] = node
    if row.get('state') in {'running', 'complete', 'failed', 'cancelled', 'partial', 'pending'}:
        event['state'] = row['state']
    # Read trusted DB descriptions only to derive enum metadata. Descriptions
    # themselves never cross the public monitoring boundary.
    message = row.get('message')
    if isinstance(message, str):
        meaning = FIXED_NODES.get((stage, message))
        if meaning:
            event['node'], event['state'] = meaning
        elif stage == 'criterion':
            match = re.fullmatch(r'([A-D][1-3]) · .{1,90}', message)
            if match:
                event['node'] = 'domain_' + match[1][0].lower()
                event['criterion'] = match[1]
    criterion = row.get('criterion')
    if isinstance(criterion, str) and re.fullmatch(r'[A-D][1-3]', criterion):
        event['criterion'] = criterion
    return event


def safe_run(row):
    ident = str(row.get('run_id', row.get('id', '')))
    if not ident or not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', ident):
        raise ValueError('Invalid run identifier')
    source = 'guest' if row.get('source') == 'guest' else 'member'
    output = {'run_id': ident, 'source': source}
    if row.get('user_id') is not None:
        output['user_ref'] = 'member-' + sha256(str(row['user_id']).encode()).hexdigest()[:10]
    elif source == 'guest':
        output['user_ref'] = 'guest-' + sha256(ident.encode()).hexdigest()[:10]
    if row.get('status') in STATUSES:
        output['status'] = row['status']
    if 'progress_percent' in row:
        output['progress_percent'] = safe_progress(row['progress_percent'])
    if 'current_stage' in row:
        stage = str(row['current_stage'] or 'queued')
        output['current_stage'] = stage if SAFE_CODE.fullmatch(stage) else 'evaluation'
    for key in ('created_at', 'started_at', 'completed_at', 'updated_at'):
        if key in row:
            output[key] = timestamp(row[key]) if row[key] is not None else None
    output['updated_at'] = output.get('updated_at') or timestamp()
    return output


class RealtimeMonitor:
    def __init__(self, config, client=None):
        secret = getattr(config, 'redis_url', '')
        url = secret.get_secret_value() if hasattr(secret, 'get_secret_value') else str(secret or '')
        self.configured = bool(url or client is not None)
        self.ttl = getattr(config, 'realtime_ttl_seconds', 86400)
        self._client = client
        self._connected = False
        self._last_attempt = 0.0
        self._lock = threading.RLock()
        self._budgets = {}
        self._budget_requests = {}
        if self._client is None and url:
            # Import lazily: the PostgreSQL monitor still works without Redis.
            try:
                from redis import Redis
                self._client = Redis.from_url(url, decode_responses=True, socket_connect_timeout=.3,
                                               socket_timeout=.3, max_connections=16)
            except ImportError:
                pass
        from app.infrastructure.browser_flow import BrowserFlowStore
        self.browser_flow = BrowserFlowStore(self._client, configured=self.configured)

    def reserve_analysis(self, scope, limit, window_seconds, idempotency_key=None):
        """Reserve paid work, atomically and fail closed on configured Redis failure.

        Call only after input validation, with user/guest identity and the input
        fingerprint in idempotency_key. No key is exposed to clients or stored
        in plaintext. A local budget is used only when Redis is not configured.
        """
        limit, window_seconds = int(limit), int(window_seconds)
        if limit < 1 or window_seconds < 1:
            raise ValueError('Analysis limits must be positive')
        key = 'careerlens:budget:' + sha256(str(scope).encode()).hexdigest()
        request_key = key + ':request:' + sha256(str(idempotency_key).encode()).hexdigest()
        if self.configured:
            try:
                if self._client is None:
                    raise ConnectionError('Redis budget unavailable')
                allowed, remaining, retry_after = self._client.eval(RESERVE_SCRIPT, 2, key, request_key,
                                                                    limit, window_seconds,
                                                                    '1' if idempotency_key is not None else '0')
                return {'allowed': bool(allowed), 'remaining': int(remaining), 'retry_after': int(retry_after),
                        'reason': None if allowed else 'limit', 'backend': 'redis'}
            except Exception:
                # Cost controls deliberately fail closed, unlike status updates.
                return {'allowed': False, 'remaining': 0, 'retry_after': 5,
                        'reason': 'unavailable', 'backend': 'redis'}
        with self._lock:
            now = time.time()
            self._budgets = {name: value for name, value in self._budgets.items() if value[1] > now}
            self._budget_requests = {name: expiry for name, expiry in self._budget_requests.items() if expiry > now}
            used, expiry = self._budgets.get(key, (0, now + window_seconds))
            duplicate = idempotency_key is not None and request_key in self._budget_requests
            allowed = duplicate or used < limit
            if allowed and not duplicate:
                used += 1
                self._budgets[key] = used, expiry
                if idempotency_key is not None:
                    self._budget_requests[request_key] = expiry
            return {'allowed': allowed, 'remaining': max(0, limit - used),
                    'retry_after': max(1, math.ceil(expiry - now)),
                    'reason': None if allowed else 'limit', 'backend': 'memory'}

    @staticmethod
    def _merge(previous, incoming, event):
        result = {**previous, **incoming}
        result['progress_percent'] = max(safe_progress(previous.get('progress_percent')),
                                         safe_progress(incoming.get('progress_percent')))
        # A late callback must never turn a persisted terminal state into running.
        if previous.get('status') in TERMINAL and incoming.get('status') not in TERMINAL:
            for key in ('status', 'current_stage', 'completed_at'):
                if key in previous:
                    result[key] = previous[key]
        events = list(previous.get('events', []))
        if event:
            events.append(event)
        result['events'] = events[-64:]
        return result

    def _write(self, incoming, event=None):
        if self._client is None:
            return False
        # Failed monitoring backs off briefly, instead of adding socket timeouts
        # to every criterion event while Redis is restarting.
        with self._lock:
            now = time.time()
            if not self._connected and now - self._last_attempt < 2:
                return False
            self._last_attempt = now
            key = PREFIX + incoming['run_id']
            try:
                from redis.exceptions import WatchError
                for _ in range(3):
                    try:
                        with self._client.pipeline() as pipe:
                            pipe.watch(key)
                            raw = pipe.get(key)
                            previous = json.loads(raw) if raw else {}
                            result = self._merge(previous, incoming, event)
                            pipe.multi()
                            pipe.setex(key, self.ttl, json.dumps(result, separators=(',', ':')))
                            pipe.zadd(INDEX, {incoming['run_id']: now})
                            pipe.zremrangebyscore(INDEX, '-inf', now - self.ttl)
                            pipe.expire(INDEX, self.ttl)
                            pipe.execute()
                        self._connected = True
                        return True
                    except WatchError:
                        continue
            except Exception:
                # Never log raw Redis errors, which may include connection URLs.
                pass
            self._connected = False
            return False

    async def publish_run(self, row, event=None):
        incoming = safe_run(row)
        return await asyncio.to_thread(self._write, incoming, safe_event(event) if event else None)

    def record_flow(self, run_id, node, state, **fields):
        """Observer compatible with GuestAnalysisService; input text is discarded."""
        state = {'complete': 'completed', 'pending': 'queued'}.get(state, state)
        row = {'run_id': run_id, 'source': 'guest', 'current_stage': node}
        if node == 'queue' and state == 'queued':
            row.update(status='queued', created_at=timestamp())
        elif node == 'analysis' and state in STATUSES:
            row['status'] = state
            if state == 'running' and fields.get('progress') == 0:
                row['started_at'] = timestamp()
            elif state in TERMINAL:
                row['completed_at'] = timestamp()
        if 'progress' in fields:
            row['progress_percent'] = fields['progress']
        self._write(safe_run(row), safe_event({'node': node, 'state': state, **fields}))

    def _cached_runs(self):
        if self._client is None:
            return [], False
        try:
            self._client.ping()
            ids = self._client.zrevrange(INDEX, 0, 199)
            values = self._client.mget([PREFIX + str(ident) for ident in ids]) if ids else []
            rows = []
            for raw in values:
                if not raw:
                    continue
                try:
                    value = json.loads(raw)
                    row = safe_run(value)
                    # Stored pseudonyms cannot carry arbitrary strings from Redis.
                    ref = value.get('user_ref', '')
                    if re.fullmatch(r'(?:member|guest)-[a-f0-9]{10}', ref):
                        row['user_ref'] = ref
                    row['events'] = [safe_event(event) for event in value.get('events', [])[-64:]]
                    rows.append(row)
                except (TypeError, ValueError):
                    continue
            self._connected = True
            return rows, True
        except Exception:
            self._connected = False
            return [], False

    async def snapshot(self, db):
        projection = 'id,user_id,status,current_stage,progress_percent,created_at,started_at,completed_at'
        # Active jobs cannot disappear behind a busy recent history window.
        active, recent = await asyncio.gather(
            db.select('evaluation_runs', select=projection, status='in.(queued,running)', order='created_at.desc', limit=100),
            db.select('evaluation_runs', select=projection, order='created_at.desc', limit=100),
        )
        durable = {str(row['id']): safe_run(row) for row in [*recent, *active]}
        cached, connected = await asyncio.to_thread(self._cached_runs)
        for row in cached:
            if row['run_id'] in durable:
                # PostgreSQL wins for status/progress after restart or cache lag.
                durable[row['run_id']]['events'] = row.get('events', [])
            elif row['source'] == 'guest':
                durable[row['run_id']] = row
        members = [row['run_id'] for row in durable.values() if row['source'] == 'member']
        if members:
            events = await db.select('progress_events', select='run_id,stage,status,progress_percent,created_at,message',
                                     run_id='in.(' + ','.join(members) + ')', order='created_at.desc', limit=2000)
            grouped = defaultdict(list)
            for event in reversed(events):
                grouped[str(event['run_id'])].append(safe_event(event))
            for ident, entries in grouped.items():
                durable[ident]['events'] = entries[-64:]
        now = datetime.now(timezone.utc)
        rows = sorted(durable.values(), key=lambda row: row.get('created_at') or '', reverse=True)
        for row in rows:
            row.setdefault('events', [])
            if row['source'] == 'member':
                # Reading a durable run is not new activity. The run table has
                # no updated_at column, so derive it only from stored evidence.
                recorded = [row.get(key) for key in ('created_at', 'started_at', 'completed_at')]
                recorded.extend(event.get('created_at') for event in row['events'])
                moments = [datetime.fromisoformat(value) for value in recorded if value]
                moments = [value if value.tzinfo else value.replace(tzinfo=timezone.utc) for value in moments]
                row['updated_at'] = max(moments).isoformat() if moments else None
            row.setdefault('user_ref', row['source'] + '-' + sha256(row['run_id'].encode()).hexdigest()[:10])
            row.setdefault('status', 'running')
            row.setdefault('progress_percent', 0)
            row.setdefault('current_stage', 'queued')
            row['stale'] = False
            if row['source'] == 'guest' and row['status'] in {'queued', 'running'}:
                changed = datetime.fromisoformat(row['updated_at'])
                if changed.tzinfo is None:
                    changed = changed.replace(tzinfo=timezone.utc)
                row['stale'] = (now - changed).total_seconds() > 180
        counts = Counter(row['status'] for row in rows)
        browser_sources, browser_status = await asyncio.to_thread(self.browser_flow.snapshot)
        return {'generated_at': now.isoformat(), 'transport': 'redis' if connected else 'postgres',
                'redis': {'configured': self.configured, 'connected': connected},
                'counts': {status: counts[status] for status in sorted(STATUSES)},
                'window': 'latest_100_and_active', 'runs': rows,
                'browser_sources': browser_sources, 'browser_status': browser_status}

    async def close(self):
        if self._client is not None:
            await asyncio.to_thread(self._client.close)
