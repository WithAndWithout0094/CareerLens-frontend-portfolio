"""Opt-in first-start setup for a NEW personal Render trial database only."""
import hashlib
import re

from psycopg import AsyncConnection
from psycopg.rows import dict_row

from app.core.asyncio import run
from app.core.config import ROOT, settings

LOCK_ID = 0x4341524545524C
MARKER = 'careerlens_personal_bootstrap'


class BootstrapRefused(RuntimeError):
    pass


def schema_identity(schema):
    tables = set(re.findall(r'^create table if not exists public\.(\w+)\s*\(', schema, re.MULTILINE))
    if not tables:
        raise BootstrapRefused('Bootstrap SQL does not contain the expected tables.')
    return hashlib.sha256(schema.encode('utf-8')).hexdigest(), tables


def needs_initialization(objects, marker_rows, fingerprint, expected_tables):
    if not objects:
        return True
    if (MARKER in objects and marker_rows == [{'schema_sha256': fingerprint}]
            and expected_tables <= objects):
        return False
    raise BootstrapRefused(
        'Database is non-empty without a matching complete personal bootstrap marker. '
        'Refusing automatic initialization or repair.'
    )


async def bootstrap(conn, schema):
    """Hold one session lock through schema, checkpoint, seed, and marker creation."""
    fingerprint, expected_tables = schema_identity(schema)
    await conn.execute("SET lock_timeout = '120s'")
    await conn.execute('SELECT pg_advisory_lock(%s)', (LOCK_ID,))
    try:
        rows = await (await conn.execute(
            "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S') "
            "UNION SELECT '#functions' WHERE EXISTS "
            "(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') "
            "UNION SELECT '#types' WHERE EXISTS "
            "(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace "
            "WHERE n.nspname='public' AND t.typtype IN ('e','d'))"
        )).fetchall()
        objects = {row['name'] for row in rows}
        marker_rows = []
        if MARKER in objects:
            marker_rows = await (await conn.execute(
                'SELECT schema_sha256 FROM public.careerlens_personal_bootstrap'
            )).fetchall()
        if not needs_initialization(objects, marker_rows, fingerprint, expected_tables):
            print('Personal Render database already initialized; keeping existing data.')
            return

        # Import setup commands only after configuration and empty-database checks.
        from scripts.apply_runtime_migration import main as initialize_schema
        from scripts.setup_checkpoints import main as setup_checkpoints
        from scripts.seed_data import main as seed_data

        await initialize_schema()
        await setup_checkpoints()
        await seed_data(100)
        # A failed/partial setup never gets a marker and is refused on the next run.
        async with conn.transaction():
            await conn.execute(
                'CREATE TABLE public.careerlens_personal_bootstrap ('
                'singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), '
                'schema_sha256 text NOT NULL, '
                'initialized_at timestamptz NOT NULL DEFAULT now())'
            )
            await conn.execute(
                'INSERT INTO public.careerlens_personal_bootstrap (schema_sha256) VALUES (%s)',
                (fingerprint,),
            )
        print('Personal Render database initialized with 100 demo job postings.')
    finally:
        await conn.execute('SELECT pg_advisory_unlock(%s)', (LOCK_ID,))


async def main():
    try:
        config = settings()
        dsn = config.database_url.get_secret_value()
        if not dsn:
            raise BootstrapRefused('DATABASE_URL is required.')
        if not config.auth_enabled or len(config.jwt_secret_key.get_secret_value()) < 32:
            raise BootstrapRefused('AUTH_ENABLED=true and JWT_SECRET_KEY of at least 32 characters are required.')
        schema = (ROOT / 'migrations/render/000_full_schema.sql').read_text(encoding='utf-8-sig')
        async with await AsyncConnection.connect(
            dsn, autocommit=True, connect_timeout=30, row_factory=dict_row,
        ) as conn:
            await bootstrap(conn, schema)
            # Additive portfolio migration, separate from the immutable bootstrap fingerprint.
            migration = (ROOT / 'migrations/render/001_admin_execution_imports.sql').read_text(encoding='utf-8')
            async with conn.transaction():
                await conn.execute(migration, prepare=False)
            print('Personal portfolio schema ready; existing records retained.')
    except BootstrapRefused as error:
        print(str(error))
        raise SystemExit(1) from None
    except Exception as error:
        print('Personal Render bootstrap failed: ' + type(error).__name__ + '. No credentials printed.')
        raise SystemExit(1) from None


if __name__ == '__main__':
    run(main())
