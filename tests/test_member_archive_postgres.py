"""Opt-in real PostgreSQL persistence checks against a disposable local database.

Never reads DATABASE_URL or connects to production. The reviewer supplies an
empty local database named careerlens_archive_test_* explicitly.
"""
import json
import os
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg.conninfo import conninfo_to_dict
import pytest

from frontend.member_report_archive import ArchiveOwnerConflict, ArchiveReportDeleted, PostgresMemberReportArchive


@pytest.fixture
def archive_database():
    dsn = os.environ.get('CAREERLENS_TEST_ARCHIVE_DATABASE_URL', '')
    if not dsn:
        pytest.skip('Explicit disposable local PostgreSQL test database was not supplied')
    options = conninfo_to_dict(dsn)
    if options.get('host') not in {'127.0.0.1', 'localhost', '::1'} or not options.get('dbname', '').startswith('careerlens_archive_test_'):
        pytest.fail('Archive integration tests require a disposable local test database')
    with psycopg.connect(dsn, autocommit=True) as connection:
        objects = connection.execute("SELECT count(*) FROM pg_tables WHERE schemaname='public'").fetchone()[0]
        if objects:
            pytest.fail('Archive integration test database must be empty')
        connection.execute('CREATE TABLE public.app_users (id uuid PRIMARY KEY)')
        migration = Path(__file__).resolve().parents[1] / 'migrations/render/002_member_guest_reports.sql'
        connection.execute(migration.read_text(encoding='utf-8'))
        # Reapplying only the additive migration must retain later data.
        owners = [uuid4(), uuid4()]
        for owner in owners:
            connection.execute('INSERT INTO public.app_users (id) VALUES (%s)', (owner,))
    try:
        yield dsn, owners, migration
    finally:
        # The fresh local-only database and exact table names were checked above.
        with psycopg.connect(dsn, autocommit=True) as connection:
            connection.execute('DROP TABLE public.member_guest_reports')
            connection.execute('DROP TABLE public.app_users')


def test_new_connections_preserve_reports_and_enforce_immutable_owner(archive_database):
    dsn, (owner, stranger), migration = archive_database
    ident = str(uuid4())
    row = {'id': ident, 'owner_user': None, 'status': 'completed', 'created': 100.0,
           'completed': 110.0, 'job_id': 'synthetic-job',
           'job_summary': json.dumps({'title': 'Synthetic role'}),
           'result': json.dumps({'report_text': 'Synthetic report', 'score': 42})}
    original = PostgresMemberReportArchive(dsn)
    original.save(str(owner), row)
    original.save(str(owner), {**row, 'result': json.dumps({'report_text': 'must not replace original'})})
    del original
    with psycopg.connect(dsn, autocommit=True) as connection:
        connection.execute(migration.read_text(encoding='utf-8'))
    restarted = PostgresMemberReportArchive(dsn)
    assert json.loads(restarted.get(str(owner), ident)['result'])['report_text'] == 'Synthetic report'
    assert len(restarted.list(str(owner), limit=20, offset=0)) == 1
    assert restarted.list(str(stranger), limit=20, offset=0) == []
    assert restarted.get(str(stranger), ident) is None
    assert not restarted.delete(str(stranger), ident)
    with pytest.raises(ArchiveOwnerConflict):
        restarted.save(str(stranger), row)
    assert restarted.get(str(owner), ident) is not None
    assert restarted.delete(str(owner), ident)
    assert PostgresMemberReportArchive(dsn).get(str(owner), ident) is None
    with pytest.raises(ArchiveReportDeleted):
        restarted.save(str(owner), row)
    with psycopg.connect(dsn) as connection:
        tombstone = connection.execute('SELECT result,job_summary,job_id FROM public.member_guest_reports WHERE id=%s', (ident,)).fetchone()
        assert tombstone == (None, {}, '')
