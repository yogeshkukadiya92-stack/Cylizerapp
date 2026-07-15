-- Phase 3B mobile trust boundary: one-time bootstrap credentials, versioned
-- consent receipts, revocable/rotatable opaque device sessions, and durable
-- replay responses for bounded call-log batches.

alter table callora.call_ingest_batches
  add column response_body jsonb,
  add constraint call_ingest_batches_response_body_object
    check (response_body is null or jsonb_typeof(response_body) = 'object');

alter table callora.employee_devices
  add column last_heartbeat_at timestamptz,
  add column battery_percent smallint,
  add column is_charging boolean,
  add column network_type text,
  add column pending_call_count integer not null default 0,
  add column pending_recording_count integer not null default 0,
  add constraint employee_devices_organization_employee_id_key
    unique (organization_id, employee_id, id),
  add constraint employee_devices_battery_percent_valid
    check (battery_percent is null or battery_percent between 0 and 100),
  add constraint employee_devices_network_type_valid
    check (network_type is null or network_type in ('offline', 'wifi', 'cellular', 'ethernet', 'unknown')),
  add constraint employee_devices_pending_call_count_valid
    check (pending_call_count between 0 and 1000000),
  add constraint employee_devices_pending_recording_count_valid
    check (pending_recording_count between 0 and 1000000),
  add constraint employee_devices_last_heartbeat_valid
    check (last_heartbeat_at is null or last_heartbeat_at >= registered_at);

create table callora.device_consent_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_id uuid not null,
  device_id uuid not null,
  policy_version text not null,
  disclosure_version text not null,
  purpose text not null,
  permissions jsonb not null,
  locale text,
  accepted_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  withdrawn_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint device_consent_receipts_employee_fk foreign key (organization_id, employee_id)
    references callora.employees (organization_id, id) on delete restrict,
  constraint device_consent_receipts_device_fk foreign key (organization_id, device_id)
    references callora.employee_devices (organization_id, id) on delete restrict,
  constraint device_consent_receipts_employee_device_fk
    foreign key (organization_id, employee_id, device_id)
    references callora.employee_devices (organization_id, employee_id, id) on delete restrict,
  constraint device_consent_receipts_organization_id_key unique (organization_id, id),
  constraint device_consent_receipts_policy_version_length
    check (char_length(btrim(policy_version)) between 1 and 64),
  constraint device_consent_receipts_disclosure_version_length
    check (char_length(btrim(disclosure_version)) between 1 and 64),
  constraint device_consent_receipts_purpose_valid
    check (purpose = 'call_metadata'),
  constraint device_consent_receipts_permissions_complete check (
    jsonb_typeof(permissions) = 'object'
    and permissions ?& array[
      'callLog', 'phoneState', 'contacts', 'notifications',
      'recordingFiles', 'backgroundExecution'
    ]
    and permissions - array[
      'callLog', 'phoneState', 'contacts', 'notifications',
      'recordingFiles', 'backgroundExecution'
    ] = '{}'::jsonb
    and permissions ->> 'callLog' in ('unknown', 'granted', 'denied', 'restricted')
    and permissions ->> 'phoneState' in ('unknown', 'granted', 'denied', 'restricted')
    and permissions ->> 'contacts' in ('unknown', 'granted', 'denied', 'restricted')
    and permissions ->> 'notifications' in ('unknown', 'granted', 'denied', 'restricted')
    and permissions ->> 'recordingFiles' in ('unknown', 'granted', 'denied', 'restricted')
    and permissions ->> 'backgroundExecution' in ('unknown', 'granted', 'denied', 'restricted')
  ),
  constraint device_consent_receipts_locale_length
    check (locale is null or char_length(btrim(locale)) between 1 and 35),
  constraint device_consent_receipts_withdrawal_valid
    check (withdrawn_at is null or withdrawn_at >= recorded_at),
  constraint device_consent_receipts_acceptance_window check (
    accepted_at >= recorded_at - interval '15 minutes'
    and accepted_at <= recorded_at + interval '5 minutes'
  )
);

create unique index device_consent_receipts_active_device_key
  on callora.device_consent_receipts (organization_id, device_id)
  where withdrawn_at is null;
create index device_consent_receipts_employee_recorded_idx
  on callora.device_consent_receipts (organization_id, employee_id, recorded_at desc, id desc);
create index device_consent_receipts_device_recorded_idx
  on callora.device_consent_receipts (organization_id, device_id, recorded_at desc, id desc);
create index device_consent_receipts_employee_device_idx
  on callora.device_consent_receipts (organization_id, employee_id, device_id);

create trigger device_consent_receipts_touch_updated_at
before update on callora.device_consent_receipts
for each row execute function callora.touch_updated_at();

create table callora.device_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_id uuid not null,
  device_id uuid not null,
  credential_type text not null,
  token_hash bytea not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  rotated_from_credential_id uuid,
  last_used_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint device_credentials_employee_fk foreign key (organization_id, employee_id)
    references callora.employees (organization_id, id) on delete restrict,
  constraint device_credentials_device_fk foreign key (organization_id, device_id)
    references callora.employee_devices (organization_id, id) on delete restrict,
  constraint device_credentials_employee_device_fk
    foreign key (organization_id, employee_id, device_id)
    references callora.employee_devices (organization_id, employee_id, id) on delete restrict,
  constraint device_credentials_rotated_from_fk foreign key (organization_id, rotated_from_credential_id)
    references callora.device_credentials (organization_id, id) on delete restrict,
  constraint device_credentials_rotated_from_device_fk
    foreign key (organization_id, device_id, rotated_from_credential_id)
    references callora.device_credentials (organization_id, device_id, id) on delete restrict,
  constraint device_credentials_organization_id_key unique (organization_id, id),
  constraint device_credentials_organization_device_id_key unique (organization_id, device_id, id),
  constraint device_credentials_token_hash_key unique (token_hash),
  constraint device_credentials_type_valid
    check (credential_type in ('bootstrap', 'session')),
  constraint device_credentials_token_hash_length
    check (octet_length(token_hash) = 32),
  constraint device_credentials_expiry_valid
    check (expires_at > created_at),
  constraint device_credentials_ttl_valid check (
    (credential_type = 'bootstrap' and expires_at <= created_at + interval '10 minutes')
    or (credential_type = 'session' and expires_at <= created_at + interval '7 days')
  ),
  constraint device_credentials_consumption_valid check (
    (credential_type = 'bootstrap')
    or consumed_at is null
  ),
  constraint device_credentials_consumed_at_valid
    check (consumed_at is null or consumed_at >= created_at),
  constraint device_credentials_revoked_at_valid
    check (revoked_at is null or revoked_at >= created_at),
  constraint device_credentials_last_used_at_valid
    check (last_used_at is null or last_used_at >= created_at),
  constraint device_credentials_rotation_valid check (
    (credential_type = 'session')
    or rotated_from_credential_id is null
  )
);

create unique index device_credentials_active_session_key
  on callora.device_credentials (organization_id, device_id)
  where credential_type = 'session' and revoked_at is null;
create index device_credentials_device_type_expiry_idx
  on callora.device_credentials (organization_id, device_id, credential_type, expires_at desc, id desc);
create index device_credentials_employee_expiry_idx
  on callora.device_credentials (organization_id, employee_id, expires_at desc, id desc);
create index device_credentials_employee_device_idx
  on callora.device_credentials (organization_id, employee_id, device_id);
create index device_credentials_rotated_from_idx
  on callora.device_credentials (organization_id, rotated_from_credential_id)
  where rotated_from_credential_id is not null;
create index device_credentials_device_rotated_from_idx
  on callora.device_credentials (organization_id, device_id, rotated_from_credential_id)
  where rotated_from_credential_id is not null;

create trigger device_credentials_touch_updated_at
before update on callora.device_credentials
for each row execute function callora.touch_updated_at();

-- Exact token-hash resolution must happen before tenant RLS context is known.
-- The directory contains only a peppered digest and opaque identifiers; runtime
-- roles have no direct table access and must use the narrow resolver below.
create table callora.device_credential_resolutions (
  token_hash bytea primary key,
  organization_id uuid not null,
  credential_id uuid not null,
  credential_type text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint device_credential_resolutions_credential_fk
    foreign key (organization_id, credential_id)
    references callora.device_credentials (organization_id, id) on delete cascade,
  constraint device_credential_resolutions_credential_key
    unique (organization_id, credential_id),
  constraint device_credential_resolutions_token_hash_length
    check (octet_length(token_hash) = 32),
  constraint device_credential_resolutions_type_valid
    check (credential_type in ('bootstrap', 'session'))
);

revoke all on table callora.device_credential_resolutions from public;

create or replace function callora.sync_device_credential_resolution()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'UPDATE' and old.token_hash is distinct from new.token_hash then
    delete from callora.device_credential_resolutions
    where token_hash = old.token_hash;
  end if;

  insert into callora.device_credential_resolutions (
    token_hash, organization_id, credential_id, credential_type, expires_at
  ) values (
    new.token_hash, new.organization_id, new.id, new.credential_type, new.expires_at
  )
  on conflict (token_hash) do update set
    organization_id = excluded.organization_id,
    credential_id = excluded.credential_id,
    credential_type = excluded.credential_type,
    expires_at = excluded.expires_at;

  return new;
end
$$;

revoke execute on function callora.sync_device_credential_resolution() from public;

create trigger device_credentials_sync_resolution
after insert or update of token_hash, credential_type, expires_at on callora.device_credentials
for each row execute function callora.sync_device_credential_resolution();

create or replace function callora.resolve_device_credential(
  p_token_hash bytea,
  p_credential_type text
)
returns table (organization_id uuid, credential_id uuid)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select resolution.organization_id, resolution.credential_id
  from callora.device_credential_resolutions as resolution
  where resolution.token_hash = p_token_hash
    and resolution.credential_type = p_credential_type
$$;

revoke execute on function callora.resolve_device_credential(bytea, text) from public;

alter table callora.device_consent_receipts enable row level security;
alter table callora.device_consent_receipts force row level security;
create policy device_consent_receipts_tenant_isolation on callora.device_consent_receipts
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

alter table callora.device_credentials enable row level security;
alter table callora.device_credentials force row level security;
create policy device_credentials_tenant_isolation on callora.device_credentials
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));
