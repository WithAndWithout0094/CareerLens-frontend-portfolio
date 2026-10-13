-- Private operational summaries imported from the owner's local execution reports.
-- No resume, prompt, model response, account ID or credential is stored here.
create table if not exists public.admin_execution_imports (
  run_id uuid primary key,
  modified_at timestamptz not null,
  imported_at timestamptz not null default now(),
  summary jsonb not null check (jsonb_typeof(summary) = 'object')
);
create index if not exists idx_admin_execution_imports_modified
  on public.admin_execution_imports(modified_at desc);
