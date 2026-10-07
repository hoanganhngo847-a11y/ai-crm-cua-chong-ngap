-- Keep Inbox raw-message audit writes compatible with the canonical audit_logs schema.
-- The Inbox runtime records both user_id and actor_id so privileged raw-content
-- access remains attributable even when actor semantics diverge from auth users.

alter table public.audit_logs
  add column if not exists actor_id uuid;

update public.audit_logs
set actor_id = user_id
where actor_id is null
  and user_id is not null;

comment on column public.audit_logs.actor_id is
  'Application actor responsible for the audited action; nullable for legacy/system events.';

-- PostgREST normally reloads automatically after DDL, but notify explicitly so
-- the staging API can use the new column immediately after the migration.
notify pgrst, 'reload schema';
