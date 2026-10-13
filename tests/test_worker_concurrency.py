"""Prove work overlaps, capacity stays bounded and leases survive cancellation."""
import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

import workers.evaluation as worker


class QueueDB:
    def __init__(self, count=4):
        self.rows = {str(index): {'id': str(index), 'user_id': f'user-{index}', 'status': 'queued'}
                     for index in range(count)}
        self.claimed = []
        self.events = []

    async def rpc(self, name, args):
        assert name == 'claim_evaluation'
        for row in self.rows.values():
            if row['status'] == 'queued':
                row.update(status='running', worker_id=args['p_worker'])
                self.claimed.append(row['id'])
                return [dict(row)]
        return []

    async def update(self, table, values, **filters):
        assert table == 'evaluation_runs'
        row = self.rows[filters['id'][3:]]
        if any(str(row.get(key)) != expression[3:] for key, expression in filters.items()):
            return []
        row.update(values)
        return [dict(row)]

    async def insert(self, table, values):
        self.events.append((table, values))
        return [values]


def config():
    return SimpleNamespace(checkpoint_enabled=False, worker_concurrency=3, worker_poll_seconds=.01,
                           worker_lease_seconds=30, evaluation_timeout_seconds=5)


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(.001)


@pytest.mark.asyncio
async def test_three_distinct_users_execute_together_fourth_waits_and_failure_is_isolated(monkeypatch):
    db = QueueDB()
    entered, cancelled, active = set(), set(), set()
    releases = {ident: asyncio.Event() for ident in db.rows}
    observed_inputs = {}

    async def evaluate(_db, _llm, _config, run, _checkpointer):
        ident = run['id']
        entered.add(ident)
        active.add(ident)
        observed_inputs[ident] = run['user_id']
        try:
            await releases[ident].wait()
            if ident == '1':
                raise RuntimeError('synthetic failure')
            return {'scores': {'validation_status': 'passed'}}
        except asyncio.CancelledError:
            cancelled.add(ident)
            raise
        finally:
            active.remove(ident)

    monkeypatch.setattr(worker, 'execute', evaluate)
    dispatcher = asyncio.create_task(worker._run_worker(db, object(), config()))
    try:
        await until(lambda: len(entered) == 3)
        assert active == {'0', '1', '2'}  # Real executor overlap, not three queued labels.
        assert db.claimed == ['0', '1', '2']
        assert observed_inputs == {str(index): f'user-{index}' for index in range(3)}
        releases['1'].set()
        await until(lambda: '3' in entered)
        assert db.rows['1']['status'] == 'failed'
        assert active == {'0', '2', '3'}
        assert not cancelled
        for event in releases.values():
            event.set()
        await until(lambda: all(row['status'] in {'completed', 'failed'} for row in db.rows.values()))
        assert [db.rows[str(index)]['status'] for index in range(4)] == ['completed', 'failed', 'completed', 'completed']
    finally:
        dispatcher.cancel()
        await asyncio.gather(dispatcher, return_exceptions=True)


@pytest.mark.asyncio
async def test_shutdown_cancels_all_evaluators_and_expires_only_owned_leases(monkeypatch):
    db = QueueDB(3)
    started, stopped = set(), set()

    async def evaluate(_db, _llm, _config, run, _checkpointer):
        started.add(run['id'])
        try:
            await asyncio.Event().wait()
        finally:
            stopped.add(run['id'])

    monkeypatch.setattr(worker, 'execute', evaluate)
    dispatcher = asyncio.create_task(worker._run_worker(db, object(), config()))
    await until(lambda: len(started) == 3)
    dispatcher.cancel()
    with pytest.raises(asyncio.CancelledError):
        await dispatcher
    assert stopped == started
    assert all(row['status'] == 'running' for row in db.rows.values())
    assert all(datetime.fromisoformat(row['lease_expires_at']) <= datetime.now(timezone.utc)
               for row in db.rows.values())


@pytest.mark.asyncio
async def test_lease_loss_cancels_execution_without_publishing_a_report(monkeypatch):
    db = QueueDB(1)
    run = (await db.rpc('claim_evaluation', {'p_worker': 'owner'}))[0]
    stopped = asyncio.Event()

    async def evaluate(*args):
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    async def lost(*args):
        return 'lease_lost_or_cancelled'

    monkeypatch.setattr(worker, 'execute', evaluate)
    monkeypatch.setattr(worker, 'heartbeat', lost)
    await worker.process(db, None, config(), run, 'owner', None)
    assert stopped.is_set()
    assert db.rows['0']['status'] == 'running'
    assert not db.events


@pytest.mark.asyncio
async def test_type_error_details_never_reach_worker_logs_or_persisted_failure(monkeypatch, caplog):
    db = QueueDB(1)
    run = (await db.rpc('claim_evaluation', {'p_worker': 'owner'}))[0]
    private_marker = 'synthetic-sensitive-provider-detail'

    async def evaluate(*_args):
        raise TypeError(private_marker)

    monkeypatch.setattr(worker, 'execute', evaluate)
    await worker.process(db, None, config(), run, 'owner', None)
    assert db.rows['0']['status'] == 'failed'
    assert db.rows['0']['failure_reason'] == 'TypeError'
    assert 'type=TypeError' in caplog.text
    assert private_marker not in caplog.text
    assert private_marker not in repr(db.rows)
    assert private_marker not in repr(db.events)
