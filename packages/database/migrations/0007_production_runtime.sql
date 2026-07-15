-- Production identity and runtime primitives used by the durable API adapter.

create table callora.user_identities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid not null,
  provider text not null default 'oidc',
  issuer text not null,
  subject text not null,
  email_at_link_time text,
  last_authenticated_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint user_identities_user_fk foreign key (organization_id, user_id)
    references callora.users (organization_id, id) on delete cascade,
  constraint user_identities_organization_id_key unique (organization_id, id),
  constraint user_identities_oidc_key unique (organization_id, issuer, subject),
  constraint user_identities_provider_format
    check (provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
  constraint user_identities_issuer_length
    check (char_length(btrim(issuer)) between 1 and 2048),
  constraint user_identities_subject_length
    check (char_length(btrim(subject)) between 1 and 1024),
  constraint user_identities_email_not_blank
    check (email_at_link_time is null or btrim(email_at_link_time) <> '')
);

create index user_identities_user_idx
  on callora.user_identities (organization_id, user_id, provider, id);
create index user_identities_last_authenticated_idx
  on callora.user_identities (organization_id, last_authenticated_at desc, id desc)
  where last_authenticated_at is not null;

create trigger user_identities_touch_updated_at
before update on callora.user_identities
for each row execute function callora.touch_updated_at();

create table callora.api_idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  scope text not null,
  idempotency_key text not null,
  request_fingerprint text not null,
  resource_type text,
  resource_id uuid,
  response_status smallint,
  response_body jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint api_idempotency_keys_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete cascade,
  constraint api_idempotency_keys_tenant_scope_key
    unique (organization_id, scope, idempotency_key),
  constraint api_idempotency_keys_scope_format
    check (scope ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  constraint api_idempotency_keys_key_length
    check (char_length(btrim(idempotency_key)) between 8 and 255),
  constraint api_idempotency_keys_fingerprint_format
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint api_idempotency_keys_resource_complete check (
    (resource_type is null and resource_id is null)
    or (resource_type is not null and resource_id is not null)
  ),
  constraint api_idempotency_keys_response_status_valid
    check (response_status is null or response_status between 100 and 599),
  constraint api_idempotency_keys_response_body_object
    check (response_body is null or jsonb_typeof(response_body) = 'object'),
  constraint api_idempotency_keys_expiry_valid check (expires_at > created_at)
);

create index api_idempotency_keys_expiry_idx
  on callora.api_idempotency_keys (organization_id, expires_at, id);
create index api_idempotency_keys_resource_idx
  on callora.api_idempotency_keys (organization_id, resource_type, resource_id)
  where resource_id is not null;

create trigger api_idempotency_keys_touch_updated_at
before update on callora.api_idempotency_keys
for each row execute function callora.touch_updated_at();

create table callora.outbox_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  aggregate_type text not null,
  aggregate_id uuid not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  available_at timestamptz not null default clock_timestamp(),
  attempt_count integer not null default 0,
  locked_at timestamptz,
  locked_by text,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint outbox_events_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete cascade,
  constraint outbox_events_organization_id_key unique (organization_id, id),
  constraint outbox_events_aggregate_type_format
    check (aggregate_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint outbox_events_event_type_format
    check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  constraint outbox_events_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint outbox_events_attempt_count_valid check (attempt_count >= 0),
  constraint outbox_events_lock_complete check (
    (locked_at is null and locked_by is null)
    or (locked_at is not null and locked_by is not null)
  ),
  constraint outbox_events_locked_by_not_blank
    check (locked_by is null or btrim(locked_by) <> ''),
  constraint outbox_events_delivery_order
    check (delivered_at is null or delivered_at >= created_at)
);

-- Workers claim only ready, undelivered rows. Tenant equality is first so the
-- index remains useful while FORCE RLS applies the organization predicate.
create index outbox_events_ready_idx
  on callora.outbox_events (organization_id, available_at, id)
  where delivered_at is null;
create index outbox_events_locked_idx
  on callora.outbox_events (organization_id, locked_at, id)
  where locked_at is not null and delivered_at is null;

create trigger outbox_events_touch_updated_at
before update on callora.outbox_events
for each row execute function callora.touch_updated_at();

alter table callora.call_logs
  add column ingest_fingerprint text,
  add constraint call_logs_ingest_fingerprint_format
    check (ingest_fingerprint is null or ingest_fingerprint ~ '^[0-9a-f]{64}$');

-- A device-less manual call still needs a stable external identity. PostgreSQL
-- unique constraints treat NULL device ids as distinct, so use a partial key.
create unique index call_logs_manual_external_key
  on callora.call_logs (organization_id, external_id)
  where source = 'manual' and device_id is null and external_id is not null;

create index employees_display_name_keyset_idx
  on callora.employees (organization_id, lower(display_name), id);

alter table callora.audit_events
  add column actor_device_id uuid,
  add constraint audit_events_actor_device_fk foreign key (organization_id, actor_device_id)
    references callora.employee_devices (organization_id, id) on delete restrict;

alter table callora.audit_events
  drop constraint audit_events_action_format,
  add constraint audit_events_action_format
    check (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$');

create index audit_events_actor_device_occurred_idx
  on callora.audit_events (organization_id, actor_device_id, occurred_at desc, id desc)
  where actor_device_id is not null;

-- Pairing redemption starts before an organization is authenticated. This
-- directory stores only a high-entropy digest and exposes no scan privilege.
-- The SECURITY DEFINER resolver performs one exact lookup; tenant reads and
-- all mutations still happen under FORCE RLS after the adapter sets context.
create table callora.pairing_code_resolutions (
  code_hash bytea primary key,
  organization_id uuid not null,
  pairing_code_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint pairing_code_resolutions_pairing_fk
    foreign key (organization_id, pairing_code_id)
    references callora.device_pairing_codes (organization_id, id) on delete cascade,
  constraint pairing_code_resolutions_pairing_key
    unique (organization_id, pairing_code_id),
  constraint pairing_code_resolutions_hash_length
    check (octet_length(code_hash) = 32)
);

revoke all on table callora.pairing_code_resolutions from public;

create or replace function callora.sync_pairing_code_resolution()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'UPDATE' and old.code_hash is distinct from new.code_hash then
    delete from callora.pairing_code_resolutions
    where code_hash = old.code_hash;
  end if;

  insert into callora.pairing_code_resolutions (
    code_hash, organization_id, pairing_code_id, expires_at
  ) values (
    new.code_hash, new.organization_id, new.id, new.expires_at
  )
  on conflict (code_hash) do update set
    organization_id = excluded.organization_id,
    pairing_code_id = excluded.pairing_code_id,
    expires_at = excluded.expires_at;

  return new;
end
$$;

revoke execute on function callora.sync_pairing_code_resolution() from public;

create trigger device_pairing_codes_sync_resolution
after insert or update of code_hash, expires_at on callora.device_pairing_codes
for each row execute function callora.sync_pairing_code_resolution();

-- Backfill active deployments. The migration owns the table and holds the
-- required lock; FORCE is restored before this transaction can commit.
alter table callora.device_pairing_codes no force row level security;
insert into callora.pairing_code_resolutions (
  code_hash, organization_id, pairing_code_id, expires_at
)
select code_hash, organization_id, id, expires_at
from callora.device_pairing_codes
on conflict (code_hash) do update set
  organization_id = excluded.organization_id,
  pairing_code_id = excluded.pairing_code_id,
  expires_at = excluded.expires_at;
alter table callora.device_pairing_codes force row level security;

create or replace function callora.resolve_pairing_code_organization(p_code_hash bytea)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select resolution.organization_id
  from callora.pairing_code_resolutions as resolution
  where resolution.code_hash = p_code_hash
$$;

revoke execute on function callora.resolve_pairing_code_organization(bytea) from public;

alter table callora.user_identities enable row level security;
alter table callora.user_identities force row level security;
create policy user_identities_tenant_isolation on callora.user_identities
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

alter table callora.api_idempotency_keys enable row level security;
alter table callora.api_idempotency_keys force row level security;
create policy api_idempotency_keys_tenant_isolation on callora.api_idempotency_keys
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

alter table callora.outbox_events enable row level security;
alter table callora.outbox_events force row level security;
create policy outbox_events_tenant_isolation on callora.outbox_events
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));
