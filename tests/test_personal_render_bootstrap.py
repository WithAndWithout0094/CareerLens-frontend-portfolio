from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from pydantic import SecretStr
from psycopg.rows import dict_row
import pytest

from scripts import apply_runtime_migration as migration
from scripts import bootstrap_personal_render as bootstrap


@pytest.mark.parametrize('has_objects', [False, True])
async def test_migration_uses_dictionary_rows_and_refuses_nonempty_schema(monkeypatch, tmp_path, capsys, has_objects):
    schema_path = tmp_path / 'migrations/render/000_full_schema.sql'
    schema_path.parent.mkdir(parents=True)
    schema_path.write_text('CREATE TABLE test_only (id integer);', encoding='utf-8')
    monkeypatch.setattr(migration, 'ROOT', tmp_path)
    monkeypatch.setattr(migration, 'settings', lambda: SimpleNamespace(database_url=SecretStr('test-only-dsn')))
    conn = MagicMock()
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=False)
    cursor = MagicMock()
    conn.execute = AsyncMock(return_value=cursor)

    async def connect(*args, **kwargs):
        # Mirror psycopg's row shape, so removing dict_row reproduces the real bug.
        row = {'has_objects': has_objects} if kwargs.get('row_factory') is dict_row else (has_objects,)
        cursor.fetchone = AsyncMock(return_value=row)
        return conn

    connect_mock = AsyncMock(side_effect=connect)
    monkeypatch.setattr(migration, 'AsyncConnection', SimpleNamespace(connect=connect_mock))
    if has_objects:
        with pytest.raises(SystemExit) as error:
            await migration.main()
        assert error.value.code == 1
        assert conn.execute.await_count == 1
    else:
        await migration.main()
        assert conn.execute.await_args.args[0] == schema_path.read_text(encoding='utf-8')
        assert conn.execute.await_args.kwargs == {'prepare': False}
    assert connect_mock.await_args.kwargs['row_factory'] is dict_row
    assert 'test-only-dsn' not in capsys.readouterr().out


def test_bootstrap_only_accepts_empty_or_matching_complete_database():
    digest = 'test-fingerprint'
    expected = {'app_users', 'job_postings'}
    marked = expected | {bootstrap.MARKER}
    assert bootstrap.needs_initialization(set(), [], digest, expected)
    assert not bootstrap.needs_initialization(marked, [{'schema_sha256': digest}], digest, expected)
    for objects, rows in [
        ({'unrelated_table'}, []),
        (expected, []),  # Even a complete pre-existing app DB is not ours to initialize.
        ({'#functions'}, []),
        ({'#types'}, []),
        (marked, []),
        (marked, [{'schema_sha256': 'older-schema'}]),
        ({bootstrap.MARKER, 'app_users'}, [{'schema_sha256': digest}]),
    ]:
        with pytest.raises(bootstrap.BootstrapRefused):
            bootstrap.needs_initialization(objects, rows, digest, expected)


def mock_connection(objects=(), marker_rows=()):
    conn = MagicMock()
    statements = []

    async def execute(query, params=None):
        statements.append(query)
        cursor = MagicMock()
        rows = list(marker_rows) if query.startswith('SELECT schema_sha256') else [{'name': name} for name in objects]
        cursor.fetchall = AsyncMock(return_value=rows)
        return cursor

    conn.execute = AsyncMock(side_effect=execute)
    transaction = MagicMock()
    transaction.__aenter__ = AsyncMock()
    transaction.__aexit__ = AsyncMock(return_value=False)
    conn.transaction.return_value = transaction
    return conn, statements


@pytest.fixture
def setup_commands(monkeypatch):
    from scripts import setup_checkpoints, seed_data
    commands = [AsyncMock(), AsyncMock(), AsyncMock()]
    monkeypatch.setattr(migration, 'main', commands[0])
    monkeypatch.setattr(setup_checkpoints, 'main', commands[1])
    monkeypatch.setattr(seed_data, 'main', commands[2])
    return commands


async def test_empty_bootstrap_writes_marker_only_after_setup_and_seeding(setup_commands):
    conn, statements = mock_connection()
    schema = 'create table if not exists public.app_users (id uuid);'
    events = []
    for command, event in zip(setup_commands, ['schema', 'checkpoints', 'seed']):
        async def record(*args, label=event):
            assert statements[-1].startswith('SELECT c.relname')
            events.append(label)
        command.side_effect = record

    await bootstrap.bootstrap(conn, schema)
    assert events == ['schema', 'checkpoints', 'seed']
    setup_commands[2].assert_awaited_once_with(100)
    assert statements[1].startswith('SELECT pg_advisory_lock')
    assert any(statement.startswith('CREATE TABLE public.careerlens_personal_bootstrap') for statement in statements)
    assert statements[-1].startswith('SELECT pg_advisory_unlock')
    conn.transaction.assert_called_once_with()


async def test_completed_bootstrap_skips_all_setup_commands(setup_commands):
    schema = 'create table if not exists public.app_users (id uuid);'
    digest, tables = bootstrap.schema_identity(schema)
    conn, statements = mock_connection(tables | {bootstrap.MARKER}, [{'schema_sha256': digest}])
    await bootstrap.bootstrap(conn, schema)
    for command in setup_commands:
        command.assert_not_awaited()
    assert not any(statement.startswith('CREATE ') for statement in statements)
    assert statements[-1].startswith('SELECT pg_advisory_unlock')


@pytest.mark.parametrize('failure_step', [0, 1, 2])
async def test_failed_bootstrap_never_marks_success_and_releases_lock(setup_commands, failure_step):
    conn, statements = mock_connection()
    setup_commands[failure_step].side_effect = RuntimeError('simulated failure')
    with pytest.raises(RuntimeError, match='simulated failure'):
        await bootstrap.bootstrap(conn, 'create table if not exists public.app_users (id uuid);')
    assert not any(statement.startswith(('CREATE TABLE public.careerlens_personal_bootstrap', 'INSERT INTO')) for statement in statements)
    assert statements[-1].startswith('SELECT pg_advisory_unlock')
    for command in setup_commands[failure_step + 1:]:
        command.assert_not_awaited()


async def test_unknown_database_does_not_invoke_any_setup(setup_commands):
    conn, statements = mock_connection({'app_users'})
    with pytest.raises(bootstrap.BootstrapRefused):
        await bootstrap.bootstrap(conn, 'create table if not exists public.app_users (id uuid);')
    for command in setup_commands:
        command.assert_not_awaited()
    assert statements[-1].startswith('SELECT pg_advisory_unlock')


async def test_invalid_auth_config_fails_before_connecting(monkeypatch, capsys):
    monkeypatch.setattr(bootstrap, 'settings', lambda: SimpleNamespace(
        database_url=SecretStr('test-only-dsn'), auth_enabled=True, jwt_secret_key=SecretStr('short'),
    ))
    connect = AsyncMock()
    monkeypatch.setattr(bootstrap, 'AsyncConnection', SimpleNamespace(connect=connect))
    with pytest.raises(SystemExit):
        await bootstrap.main()
    connect.assert_not_awaited()
    assert 'test-only-dsn' not in capsys.readouterr().out
