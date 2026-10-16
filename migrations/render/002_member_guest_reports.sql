-- Additive durable storage for completed guest analyses claimed by a member.
-- The original bootstrap schema/fingerprint and existing records stay intact.
CREATE TABLE IF NOT EXISTS public.member_guest_reports (
    id uuid PRIMARY KEY,
    owner_user uuid NOT NULL REFERENCES public.app_users(id),
    status text NOT NULL CHECK (status IN ('completed', 'partial')),
    created double precision NOT NULL,
    completed double precision NOT NULL,
    job_id text NOT NULL,
    job_summary jsonb NOT NULL,
    result jsonb,
    deleted_at timestamptz,
    CHECK ((deleted_at IS NULL) = (result IS NOT NULL)),
    archived_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS member_guest_reports_owner_created
    ON public.member_guest_reports (owner_user, created DESC, id DESC);
REVOKE ALL ON public.member_guest_reports FROM PUBLIC;
