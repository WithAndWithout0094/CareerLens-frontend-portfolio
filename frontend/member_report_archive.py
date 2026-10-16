"""Durable private copies of guest reports, bound to the verified member ID.

Only the integrated backend enables this adapter. SQLite remains the short-lived
guest work queue; a successful claim requires this archive to commit first.
"""

import json
from contextlib import contextmanager
from uuid import UUID

from psycopg import connect
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


class ArchiveOwnerConflict(Exception):
    """A report ID is already bound to another verified account."""


class ArchiveReportDeleted(Exception):
    """A stale SQLite copy must not recreate an explicitly deleted report."""


class PostgresMemberReportArchive:
    def __init__(self, dsn):
        self._dsn = dsn

    @contextmanager
    def connection(self):
        # Called from the Flask worker thread, never the asyncio event loop.
        # No DSN, SQL parameter or report content is logged or returned on error.
        with connect(self._dsn, row_factory=dict_row, connect_timeout=10,
                     options='-c statement_timeout=15000') as connection:
            yield connection

    @staticmethod
    def row(record):
        if record is None:
            return None
        return {**record, 'id': str(record['id']), 'owner_user': str(record['owner_user']),
                'job_summary': json.dumps(record['job_summary'], ensure_ascii=False),
                **({'result': json.dumps(record['result'], ensure_ascii=False)} if 'result' in record else {})}

    def save(self, uid, row):
        uid, ident = UUID(str(uid)), UUID(str(row['id']))
        if row['owner_user'] not in (None, str(uid)):
            raise ArchiveOwnerConflict()
        if row['status'] not in {'completed', 'partial'} or not row['result']:
            raise ValueError('Only completed reports may be archived')
        with self.connection() as connection:
            connection.execute(
                'INSERT INTO public.member_guest_reports '
                '(id,owner_user,status,created,completed,job_id,job_summary,result) '
                'VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING',
                (ident, uid, row['status'], row['created'], row['completed'], row['job_id'],
                 Jsonb(json.loads(row['job_summary'])), Jsonb(json.loads(row['result']))),
            )
            existing = connection.execute(
                'SELECT owner_user,deleted_at FROM public.member_guest_reports WHERE id=%s', (ident,),
            ).fetchone()
            if existing is None or existing['owner_user'] != uid:
                raise ArchiveOwnerConflict()
            if existing['deleted_at'] is not None:
                raise ArchiveReportDeleted()

    def list(self, uid, *, limit, offset):
        with self.connection() as connection:
            rows = connection.execute(
                'SELECT id,owner_user,status,created,completed,job_id,job_summary '
                'FROM public.member_guest_reports WHERE owner_user=%s AND deleted_at IS NULL '
                'ORDER BY created DESC,id DESC LIMIT %s OFFSET %s',
                (UUID(str(uid)), limit, offset),
            ).fetchall()
        return [self.row(row) for row in rows]

    def get(self, uid, ident):
        with self.connection() as connection:
            row = connection.execute(
                'SELECT * FROM public.member_guest_reports WHERE id=%s AND owner_user=%s AND deleted_at IS NULL',
                (UUID(str(ident)), UUID(str(uid))),
            ).fetchone()
        return self.row(row)

    def delete(self, uid, ident):
        with self.connection() as connection:
            return connection.execute(
                # Retain only an ownership tombstone. This prevents a stale local
                # copy from restoring a deleted private result after a crash.
                "UPDATE public.member_guest_reports SET result=NULL,job_summary='{}'::jsonb,job_id='',deleted_at=now() "
                'WHERE id=%s AND owner_user=%s AND deleted_at IS NULL',
                (UUID(str(ident)), UUID(str(uid))),
            ).rowcount > 0
