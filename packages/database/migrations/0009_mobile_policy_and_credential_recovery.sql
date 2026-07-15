-- Phase 3C mobile recovery and policy authority. Policy disclosure content is
-- server-owned and content-addressed. Device secrets remain client-proposed
-- digests only. Request-bound transition functions provide exact replay
-- without making consumed, pending, or revoked credentials generally usable.

create table callora.mobile_collection_policies (
  id uuid primary key,
  policy_version text not null,
  disclosure_version text not null,
  platform text not null,
  collection_mode text not null,
  purpose text not null default 'call_metadata',
  title text not null,
  summary text not null,
  disclosures jsonb not null,
  content_hash bytea not null,
  effective_at timestamptz not null,
  retired_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint mobile_collection_policies_id_content_hash_key unique (id, content_hash),
  constraint mobile_collection_policies_receipt_identity_key
    unique (id, content_hash, policy_version, disclosure_version, purpose),
  constraint mobile_collection_policies_content_hash_key unique (content_hash),
  constraint mobile_collection_policies_version_key
    unique (platform, collection_mode, purpose, policy_version),
  constraint mobile_collection_policies_policy_version_length
    check (char_length(btrim(policy_version)) between 1 and 64),
  constraint mobile_collection_policies_disclosure_version_length
    check (char_length(btrim(disclosure_version)) between 1 and 64),
  constraint mobile_collection_policies_platform_valid
    check (platform = 'android'),
  constraint mobile_collection_policies_collection_mode_valid
    check (collection_mode in ('android_call_log', 'synthetic_demo')),
  constraint mobile_collection_policies_purpose_valid
    check (purpose = 'call_metadata'),
  constraint mobile_collection_policies_title_length
    check (char_length(btrim(title)) between 1 and 160),
  constraint mobile_collection_policies_summary_length
    check (char_length(btrim(summary)) between 1 and 2000),
  constraint mobile_collection_policies_disclosures_array
    check (
      jsonb_typeof(disclosures) = 'array'
      and jsonb_array_length(disclosures) > 0
      and not jsonb_path_exists(disclosures, '$[*] ? (@.type() != "string")')
    ),
  constraint mobile_collection_policies_content_hash_length
    check (octet_length(content_hash) = 32),
  constraint mobile_collection_policies_retirement_valid
    check (retired_at is null or retired_at > effective_at),
  constraint mobile_collection_policies_timestamp_order
    check (updated_at >= created_at)
);

revoke all on table callora.mobile_collection_policies from public;

create or replace function callora.set_mobile_collection_policy_content_hash()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  new.content_hash := public.digest(
    convert_to(
      jsonb_build_object(
        'id', new.id,
        'policyVersion', new.policy_version,
        'disclosureVersion', new.disclosure_version,
        'platform', new.platform,
        'collectionMode', new.collection_mode,
        'purpose', new.purpose,
        'title', new.title,
        'summary', new.summary,
        'disclosures', new.disclosures
      )::text,
      'UTF8'
    ),
    'sha256'
  );
  return new;
end
$$;

revoke execute on function callora.set_mobile_collection_policy_content_hash() from public;

create trigger mobile_collection_policies_set_content_hash
before insert on callora.mobile_collection_policies
for each row execute function callora.set_mobile_collection_policy_content_hash();

create or replace function callora.guard_mobile_collection_policy_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'mobile collection policies are immutable' using errcode = '55000';
  end if;

  if old.retired_at is null
     and new.retired_at is not null
     and new.retired_at > old.effective_at
     and (to_jsonb(new) - array['retired_at', 'updated_at'])
       = (to_jsonb(old) - array['retired_at', 'updated_at']) then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  raise exception 'mobile collection policy content is immutable' using errcode = '55000';
end
$$;

revoke execute on function callora.guard_mobile_collection_policy_mutation() from public;

create trigger mobile_collection_policies_guard_mutation
before update or delete on callora.mobile_collection_policies
for each row execute function callora.guard_mobile_collection_policy_mutation();

create or replace function callora.prevent_mobile_collection_policy_overlap()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended(new.platform || ':' || new.collection_mode || ':' || new.purpose, 0)
  );
  if exists (
    select 1
    from callora.mobile_collection_policies as existing
    where existing.id <> new.id
      and existing.platform = new.platform
      and existing.collection_mode = new.collection_mode
      and existing.purpose = new.purpose
      and existing.effective_at < coalesce(new.retired_at, 'infinity'::timestamptz)
      and new.effective_at < coalesce(existing.retired_at, 'infinity'::timestamptz)
  ) then
    raise exception 'mobile collection policy effective windows cannot overlap'
      using errcode = '23P01';
  end if;
  return new;
end
$$;

revoke execute on function callora.prevent_mobile_collection_policy_overlap() from public;

create trigger mobile_collection_policies_prevent_overlap
before insert or update of platform, collection_mode, purpose, effective_at, retired_at
on callora.mobile_collection_policies
for each row execute function callora.prevent_mobile_collection_policy_overlap();

insert into callora.mobile_collection_policies (
  id, policy_version, disclosure_version, platform, collection_mode, purpose,
  title, summary, disclosures, content_hash, effective_at, created_at, updated_at
) values
  (
    '30000000-0000-4000-8000-000000000001',
    '2026.1-demo-call-metadata',
    '2026.1-demo-disclosure',
    'android',
    'synthetic_demo',
    'call_metadata',
    'Callora demo call metadata',
    'Uses generated demonstration calls only. It does not read the device call log.',
    '[
      "Uses synthetic demonstration data generated inside the app.",
      "Includes phone number, direction, start time, duration, disposition, and device-scoped external ID.",
      "Requires no Android call-log permission.",
      "Does not collect call audio, microphone audio, SMS content, or the contacts address book."
    ]'::jsonb,
    decode(repeat('00', 32), 'hex'),
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '2026.1-enterprise-call-metadata',
    '2026.1-enterprise-disclosure',
    'android',
    'android_call_log',
    'call_metadata',
    'Callora enterprise call metadata',
    'With employee consent and Android permission, reads call-history metadata and synchronizes it to the organization workspace.',
    '[
      "Reads Android call-history metadata only after prominent disclosure, consent, and READ_CALL_LOG permission.",
      "Includes phone number, direction, start time, duration, disposition, SIM-slot reference, and device-scoped external ID.",
      "Synchronizes the metadata to the employee organization workspace.",
      "Does not collect call audio, microphone audio, SMS content, or the contacts address book."
    ]'::jsonb,
    decode(repeat('00', 32), 'hex'),
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z'
  );

create index mobile_collection_policies_current_idx
  on callora.mobile_collection_policies
    (platform, collection_mode, purpose, effective_at desc, id desc)
  where retired_at is null;

create unique index mobile_collection_policies_unretired_key
  on callora.mobile_collection_policies (platform, collection_mode, purpose)
  where retired_at is null;

create or replace function callora.resolve_mobile_collection_policy(
  p_collection_mode text,
  p_purpose text,
  p_at timestamptz
)
returns table (
  id uuid,
  policy_version text,
  disclosure_version text,
  platform text,
  collection_mode text,
  purpose text,
  title text,
  summary text,
  disclosures jsonb,
  content_hash bytea,
  effective_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    policy.id,
    policy.policy_version,
    policy.disclosure_version,
    policy.platform,
    policy.collection_mode,
    policy.purpose,
    policy.title,
    policy.summary,
    policy.disclosures,
    policy.content_hash,
    policy.effective_at
  from callora.mobile_collection_policies as policy
  where policy.collection_mode = p_collection_mode
    and policy.platform = 'android'
    and policy.purpose = p_purpose
    and policy.effective_at <= p_at
    and (policy.retired_at is null or policy.retired_at > p_at)
  order by policy.effective_at desc, policy.id desc
  limit 1
$$;

revoke execute on function callora.resolve_mobile_collection_policy(text, text, timestamptz)
  from public;

alter table callora.device_pairing_codes
  add column collection_mode text not null default 'android_call_log',
  add constraint device_pairing_codes_collection_mode_valid
    check (collection_mode in ('android_call_log', 'synthetic_demo'));

alter table callora.employee_devices
  add column collection_mode text not null default 'android_call_log',
  add constraint employee_devices_collection_mode_valid
    check (collection_mode in ('android_call_log', 'synthetic_demo'));

create index employee_devices_collection_mode_status_idx
  on callora.employee_devices (organization_id, collection_mode, status, id);

alter table callora.device_consent_receipts
  add column policy_id uuid,
  add column policy_content_hash bytea,
  add constraint device_consent_receipts_policy_content_hash_length
    check (policy_content_hash is null or octet_length(policy_content_hash) = 32);

-- Existing Phase 3B receipts predate policy identifiers. Preserve their
-- history and bind it to the enterprise call-metadata disclosure used by the
-- upgrade default. FORCE is restored before this migration can commit.
alter table callora.device_consent_receipts no force row level security;
update callora.device_consent_receipts as receipt
set policy_id = policy.id,
    policy_content_hash = policy.content_hash,
    policy_version = policy.policy_version,
    disclosure_version = policy.disclosure_version,
    purpose = policy.purpose
from callora.mobile_collection_policies as policy
where policy.id = '30000000-0000-4000-8000-000000000002'
  and receipt.policy_id is null;
alter table callora.device_consent_receipts force row level security;

alter table callora.device_consent_receipts
  alter column policy_id set not null,
  alter column policy_content_hash set not null,
  add constraint device_consent_receipts_policy_hash_fk
    foreign key (policy_id, policy_content_hash)
    references callora.mobile_collection_policies (id, content_hash) on delete restrict,
  add constraint device_consent_receipts_policy_fk
    foreign key (
      policy_id, policy_content_hash, policy_version, disclosure_version, purpose
    ) references callora.mobile_collection_policies (
      id, content_hash, policy_version, disclosure_version, purpose
    ) on delete restrict;

create index device_consent_receipts_policy_idx
  on callora.device_consent_receipts (
    policy_id, policy_content_hash, policy_version, disclosure_version, purpose
  );

drop trigger device_consent_receipts_touch_updated_at
  on callora.device_consent_receipts;

create or replace function callora.guard_device_consent_receipt_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'consent receipts are append-only' using errcode = '55000';
  end if;

  if old.withdrawn_at is null
     and new.withdrawn_at is not null
     and new.withdrawn_at >= old.recorded_at
     and (to_jsonb(new) - array['withdrawn_at', 'updated_at'])
       = (to_jsonb(old) - array['withdrawn_at', 'updated_at']) then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  raise exception 'consent receipts are append-only except one-way withdrawal'
    using errcode = '55000';
end
$$;

revoke execute on function callora.guard_device_consent_receipt_mutation() from public;

create trigger device_consent_receipts_guard_mutation
before update or delete on callora.device_consent_receipts
for each row execute function callora.guard_device_consent_receipt_mutation();

drop index callora.device_credentials_active_session_key;

alter table callora.device_credentials
  add column lifecycle_state text,
  add column request_id uuid,
  add column acknowledged_at timestamptz;

alter table callora.device_credentials no force row level security;
update callora.device_credentials
set lifecycle_state = case
      when revoked_at is not null then 'revoked'
      when consumed_at is not null then 'consumed'
      else 'active'
    end,
    acknowledged_at = case
      when credential_type = 'session' and revoked_at is null and consumed_at is null
        then created_at
      else null
    end;
alter table callora.device_credentials force row level security;

alter table callora.device_credentials
  alter column lifecycle_state set default 'active',
  alter column lifecycle_state set not null,
  add constraint device_credentials_lifecycle_state_valid
    check (lifecycle_state in ('pending', 'active', 'consumed', 'revoked')),
  add constraint device_credentials_lifecycle_timestamps_valid check (
    (lifecycle_state = 'pending'
      and credential_type = 'session'
      and consumed_at is null and revoked_at is null and acknowledged_at is null)
    or (lifecycle_state = 'active'
      and consumed_at is null and revoked_at is null)
    or (lifecycle_state = 'consumed'
      and credential_type = 'bootstrap'
      and consumed_at is not null and revoked_at is null)
    or (lifecycle_state = 'revoked' and revoked_at is not null)
  ),
  add constraint device_credentials_acknowledged_at_valid
    check (acknowledged_at is null or acknowledged_at >= created_at),
  add constraint device_credentials_request_required_for_pending
    check (lifecycle_state <> 'pending' or request_id is not null),
  add constraint device_credentials_device_token_identity_key
    unique (organization_id, device_id, id, token_hash);

create unique index device_credentials_active_session_key
  on callora.device_credentials (organization_id, device_id)
  where credential_type = 'session' and lifecycle_state = 'active';

create unique index device_credentials_pending_session_key
  on callora.device_credentials (organization_id, device_id)
  where credential_type = 'session' and lifecycle_state = 'pending';

create index device_credentials_device_state_expiry_idx
  on callora.device_credentials
    (organization_id, device_id, credential_type, lifecycle_state, expires_at desc, id desc);

create table callora.device_credential_requests (
  id uuid primary key,
  organization_id uuid not null,
  employee_id uuid not null,
  device_id uuid not null,
  credential_id uuid,
  credential_token_hash bytea,
  pairing_code_id uuid,
  parent_request_id uuid,
  operation text not null,
  request_fingerprint bytea not null,
  proposed_credential_id uuid,
  proposed_token_hash bytea,
  response_body jsonb not null,
  completed_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint device_credential_requests_organization_id_key
    unique (organization_id, id),
  constraint device_credential_requests_organization_device_id_key
    unique (organization_id, device_id, id),
  constraint device_credential_requests_device_operation_id_key
    unique (organization_id, device_id, operation, id),
  constraint device_credential_requests_employee_fk
    foreign key (organization_id, employee_id)
    references callora.employees (organization_id, id) on delete restrict,
  constraint device_credential_requests_device_fk
    foreign key (organization_id, employee_id, device_id)
    references callora.employee_devices (organization_id, employee_id, id) on delete restrict,
  constraint device_credential_requests_credential_fk
    foreign key (organization_id, device_id, credential_id, credential_token_hash)
    references callora.device_credentials (organization_id, device_id, id, token_hash)
    on delete restrict,
  constraint device_credential_requests_pairing_fk
    foreign key (organization_id, pairing_code_id)
    references callora.device_pairing_codes (organization_id, id) on delete restrict,
  constraint device_credential_requests_parent_request_fk
    foreign key (organization_id, device_id, parent_request_id)
    references callora.device_credential_requests (organization_id, device_id, id)
    on delete restrict deferrable initially deferred,
  constraint device_credential_requests_proposed_credential_fk
    foreign key (organization_id, device_id, proposed_credential_id, proposed_token_hash)
    references callora.device_credentials (organization_id, device_id, id, token_hash)
    on delete restrict deferrable initially deferred,
  constraint device_credential_requests_operation_valid
    check (operation in (
      'redeem', 'activate', 'rotation_prepare',
      'rotation_confirm', 'reconsent', 'revoke'
    )),
  constraint device_credential_requests_fingerprint_length
    check (octet_length(request_fingerprint) = 32),
  constraint device_credential_requests_credential_complete check (
    (credential_id is null and credential_token_hash is null)
    or (credential_id is not null and credential_token_hash is not null)
  ),
  constraint device_credential_requests_credential_hash_length
    check (credential_token_hash is null or octet_length(credential_token_hash) = 32),
  constraint device_credential_requests_proposal_complete check (
    (proposed_credential_id is null and proposed_token_hash is null)
    or (proposed_credential_id is not null and proposed_token_hash is not null)
  ),
  constraint device_credential_requests_proposed_hash_length
    check (proposed_token_hash is null or octet_length(proposed_token_hash) = 32),
  constraint device_credential_requests_operation_shape check (
    (operation = 'redeem'
      and pairing_code_id is not null and parent_request_id is null
      and credential_id is null and credential_token_hash is null
      and proposed_credential_id is not null)
    or (operation in ('activate', 'rotation_prepare')
      and pairing_code_id is null and parent_request_id is null
      and credential_id is not null and credential_token_hash is not null
      and proposed_credential_id is not null)
    or (operation = 'rotation_confirm'
      and pairing_code_id is null and parent_request_id is not null
      and credential_id is not null and credential_token_hash is not null
      and proposed_credential_id is null)
    or (operation in ('reconsent', 'revoke')
      and pairing_code_id is null and parent_request_id is null
      and credential_id is not null and credential_token_hash is not null
      and proposed_credential_id is null)
  ),
  constraint device_credential_requests_response_object
    check (jsonb_typeof(response_body) = 'object'),
  constraint device_credential_requests_response_has_no_token check (
    not (response_body ?| array[
      'token', 'bootstrapToken', 'sessionToken',
      'bootstrapCredential', 'sessionCredential'
    ])
  ),
  constraint device_credential_requests_completion_order
    check (completed_at >= created_at),
  constraint device_credential_requests_update_order
    check (updated_at >= created_at)
);

create index device_credential_requests_employee_idx
  on callora.device_credential_requests
    (organization_id, employee_id, created_at desc, id desc);
create index device_credential_requests_device_idx
  on callora.device_credential_requests
    (organization_id, employee_id, device_id, created_at desc, id desc);
create index device_credential_requests_credential_idx
  on callora.device_credential_requests
    (organization_id, device_id, credential_id, credential_token_hash)
  where credential_id is not null;
create index device_credential_requests_pairing_idx
  on callora.device_credential_requests (organization_id, pairing_code_id)
  where pairing_code_id is not null;
create index device_credential_requests_parent_idx
  on callora.device_credential_requests
    (organization_id, device_id, parent_request_id)
  where parent_request_id is not null;
create index device_credential_requests_proposed_idx
  on callora.device_credential_requests
    (organization_id, device_id, proposed_credential_id, proposed_token_hash)
  where proposed_credential_id is not null;

alter table callora.device_credentials
  add constraint device_credentials_request_fk
    foreign key (organization_id, device_id, request_id)
    references callora.device_credential_requests (organization_id, device_id, id)
    on delete restrict deferrable initially deferred;

create index device_credentials_request_idx
  on callora.device_credentials (organization_id, device_id, request_id)
  where request_id is not null;

create or replace function callora.reject_device_credential_request_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  raise exception 'device credential requests are append-only' using errcode = '55000';
end
$$;

revoke execute on function callora.reject_device_credential_request_mutation() from public;

create trigger device_credential_requests_append_only
before update or delete on callora.device_credential_requests
for each row execute function callora.reject_device_credential_request_mutation();

-- Exact replay begins before tenant context can be re-established. This
-- directory contains digests and opaque identifiers only; runtime roles have
-- no table privilege and can perform only exact request-bound lookups.
create table callora.device_credential_request_resolutions (
  request_id uuid primary key,
  organization_id uuid not null,
  employee_id uuid not null,
  device_id uuid not null,
  operation text not null,
  request_fingerprint bytea not null,
  credential_id uuid,
  credential_token_hash bytea,
  pairing_code_id uuid,
  parent_request_id uuid,
  proposed_credential_id uuid,
  proposed_token_hash bytea,
  response_body jsonb not null,
  completed_at timestamptz not null,
  created_at timestamptz not null,
  constraint device_credential_request_resolutions_request_fk
    foreign key (organization_id, request_id)
    references callora.device_credential_requests (organization_id, id) on delete cascade,
  constraint device_credential_request_resolutions_request_key
    unique (organization_id, request_id),
  constraint device_credential_request_resolutions_fingerprint_length
    check (octet_length(request_fingerprint) = 32),
  constraint device_credential_request_resolutions_credential_hash_length
    check (credential_token_hash is null or octet_length(credential_token_hash) = 32),
  constraint device_credential_request_resolutions_proposed_hash_length
    check (proposed_token_hash is null or octet_length(proposed_token_hash) = 32),
  constraint device_credential_request_resolutions_response_object
    check (jsonb_typeof(response_body) = 'object')
);

revoke all on table callora.device_credential_request_resolutions from public;

create index device_credential_request_resolutions_source_idx
  on callora.device_credential_request_resolutions
    (credential_token_hash, request_id, operation, request_fingerprint)
  where credential_token_hash is not null;
create index device_credential_request_resolutions_proposed_idx
  on callora.device_credential_request_resolutions
    (proposed_token_hash, request_id, operation, request_fingerprint)
  where proposed_token_hash is not null;
create index device_credential_request_resolutions_pairing_idx
  on callora.device_credential_request_resolutions
    (organization_id, pairing_code_id, request_id)
  where pairing_code_id is not null;

create or replace function callora.sync_device_credential_request_resolution()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  insert into callora.device_credential_request_resolutions (
    request_id, organization_id, employee_id, device_id, operation,
    request_fingerprint, credential_id, credential_token_hash,
    pairing_code_id, parent_request_id, proposed_credential_id,
    proposed_token_hash, response_body, completed_at, created_at
  ) values (
    new.id, new.organization_id, new.employee_id, new.device_id, new.operation,
    new.request_fingerprint, new.credential_id, new.credential_token_hash,
    new.pairing_code_id, new.parent_request_id, new.proposed_credential_id,
    new.proposed_token_hash, new.response_body, new.completed_at, new.created_at
  );
  return new;
end
$$;

revoke execute on function callora.sync_device_credential_request_resolution() from public;

create trigger device_credential_requests_sync_resolution
after insert on callora.device_credential_requests
for each row execute function callora.sync_device_credential_request_resolution();

alter table callora.device_credential_resolutions
  add column lifecycle_state text not null default 'active',
  add constraint device_credential_resolutions_lifecycle_state_valid
    check (lifecycle_state in ('pending', 'active', 'consumed', 'revoked'));

alter table callora.device_credentials no force row level security;
update callora.device_credential_resolutions as resolution
set lifecycle_state = credential.lifecycle_state
from callora.device_credentials as credential
where credential.organization_id = resolution.organization_id
  and credential.id = resolution.credential_id;
alter table callora.device_credentials force row level security;

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
    token_hash, organization_id, credential_id, credential_type,
    lifecycle_state, expires_at
  ) values (
    new.token_hash, new.organization_id, new.id, new.credential_type,
    new.lifecycle_state, new.expires_at
  )
  on conflict (token_hash) do update set
    organization_id = excluded.organization_id,
    credential_id = excluded.credential_id,
    credential_type = excluded.credential_type,
    lifecycle_state = excluded.lifecycle_state,
    expires_at = excluded.expires_at;

  return new;
end
$$;

drop trigger device_credentials_sync_resolution on callora.device_credentials;
create trigger device_credentials_sync_resolution
after insert or update of token_hash, credential_type, lifecycle_state, expires_at
on callora.device_credentials
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
    and resolution.lifecycle_state = 'active'
$$;

create table callora.mobile_rate_limits (
  key_hash bytea not null,
  operation text not null,
  bucket smallint not null,
  window_started_at timestamptz not null,
  attempt_count integer not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (key_hash, operation),
  constraint mobile_rate_limits_key_hash_length
    check (octet_length(key_hash) = 32),
  constraint mobile_rate_limits_operation_format
    check (operation ~ '^[a-z][a-z_]{0,63}$'),
  constraint mobile_rate_limits_bucket_valid
    check (bucket between 0 and 63),
  constraint mobile_rate_limits_attempt_count_valid
    check (attempt_count between 1 and 100),
  constraint mobile_rate_limits_expiry_valid
    check (expires_at > window_started_at and expires_at <= window_started_at + interval '24 hours')
);

revoke all on table callora.mobile_rate_limits from public;

create index mobile_rate_limits_expiry_idx
  on callora.mobile_rate_limits (expires_at, key_hash, operation);
create index mobile_rate_limits_bucket_expiry_idx
  on callora.mobile_rate_limits (bucket, expires_at, key_hash, operation);

-- Compatibility name retained for the pairing-specific fixed-window contract.
create view callora.pairing_redemption_attempts as
select key_hash as subject_hash, window_started_at, attempt_count, expires_at, updated_at
from callora.mobile_rate_limits
where operation = 'pairing_redeem';

revoke all on table callora.pairing_redemption_attempts from public;

create or replace function callora.consume_mobile_rate_limit(
  p_key_hash bytea,
  p_operation text,
  p_max_attempts integer,
  p_window_seconds integer,
  p_attempted_at timestamptz
)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_row callora.mobile_rate_limits%rowtype;
  v_expires_at timestamptz;
  v_bucket smallint;
  v_bucket_count integer;
  v_next_expiry timestamptz;
begin
  if octet_length(p_key_hash) <> 32
     or p_operation !~ '^[a-z][a-z_]{0,63}$'
     or p_max_attempts not between 1 and 100
     or p_window_seconds not between 1 and 86400 then
    raise exception 'invalid mobile rate-limit policy' using errcode = '22023';
  end if;

  v_expires_at := p_attempted_at + make_interval(secs => p_window_seconds);
  v_bucket := ((get_byte(p_key_hash, 0) * 256 + get_byte(p_key_hash, 1)) % 64)::smallint;

  -- Runtime roles have no direct table writes. A 64-way advisory lock makes
  -- cleanup + capacity admission atomic without serializing unrelated shards.
  perform pg_advisory_xact_lock(914203, v_bucket::integer);

  delete from callora.mobile_rate_limits
  where ctid in (
    select stale.ctid
    from callora.mobile_rate_limits as stale
    where stale.bucket = v_bucket and stale.expires_at <= p_attempted_at
    order by stale.expires_at, stale.key_hash, stale.operation
    limit 64
  );

  if not exists (
    select 1 from callora.mobile_rate_limits as current_key
    where current_key.key_hash = p_key_hash and current_key.operation = p_operation
  ) then
    select count(*), min(limiter.expires_at)
      into v_bucket_count, v_next_expiry
    from callora.mobile_rate_limits as limiter
    where limiter.bucket = v_bucket;
    if v_bucket_count >= 4096 then
      return query select
        false,
        greatest(
          1,
          ceil(extract(epoch from (v_next_expiry - p_attempted_at)))::integer
        );
      return;
    end if;
  end if;

  insert into callora.mobile_rate_limits (
    key_hash, operation, bucket,
    window_started_at, attempt_count, expires_at, updated_at
  ) values (
    p_key_hash, p_operation, v_bucket,
    p_attempted_at, 1, v_expires_at, p_attempted_at
  )
  on conflict (key_hash, operation) do nothing
  returning * into v_row;

  if found then
    return query select true, 0;
    return;
  end if;

  select * into strict v_row
  from callora.mobile_rate_limits as limiter
  where limiter.key_hash = p_key_hash and limiter.operation = p_operation
  for update;

  if v_row.expires_at <= p_attempted_at then
    update callora.mobile_rate_limits
    set window_started_at = p_attempted_at,
        attempt_count = 1,
        expires_at = v_expires_at,
        updated_at = p_attempted_at
    where key_hash = p_key_hash and operation = p_operation;
    return query select true, 0;
    return;
  end if;

  if v_row.attempt_count < p_max_attempts then
    update callora.mobile_rate_limits
    set attempt_count = attempt_count + 1,
        updated_at = p_attempted_at
    where key_hash = p_key_hash and operation = p_operation;
    return query select true, 0;
    return;
  end if;

  return query select
    false,
    greatest(1, ceil(extract(epoch from (v_row.expires_at - p_attempted_at)))::integer);
end
$$;

revoke execute on function callora.consume_mobile_rate_limit(
  bytea, text, integer, integer, timestamptz
) from public;

create or replace function callora.consume_pairing_redemption_attempt(
  p_subject_hash bytea,
  p_attempted_at timestamptz
)
returns table (allowed boolean, retry_after_seconds integer)
language sql
volatile
security definer
set search_path = pg_catalog
as $$
  select result.allowed, result.retry_after_seconds
  from callora.consume_mobile_rate_limit(
    p_subject_hash, 'pairing_redeem', 5, 600, p_attempted_at
  ) as result
$$;

revoke execute on function callora.consume_pairing_redemption_attempt(bytea, timestamptz)
  from public;

create or replace function callora.write_mobile_transition_evidence(
  p_organization_id uuid,
  p_device_id uuid,
  p_request_id uuid,
  p_action text,
  p_event_type text,
  p_metadata jsonb,
  p_occurred_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  insert into callora.audit_events (
    organization_id, actor_device_id, action, entity_type, entity_id,
    request_id, metadata, occurred_at, created_at
  ) values (
    p_organization_id, p_device_id, p_action, 'device', p_device_id,
    p_request_id::text, p_metadata, p_occurred_at, p_occurred_at
  );

  insert into callora.outbox_events (
    organization_id, aggregate_type, aggregate_id, event_type, payload,
    available_at, created_at, updated_at
  ) values (
    p_organization_id, 'device', p_device_id, p_event_type,
    p_metadata || jsonb_build_object('requestId', p_request_id),
    p_occurred_at, p_occurred_at, p_occurred_at
  );
end
$$;

revoke execute on function callora.write_mobile_transition_evidence(
  uuid, uuid, uuid, text, text, jsonb, timestamptz
) from public;

create or replace function callora.resolve_pairing_redemption_replay(
  p_code_hash bytea,
  p_request_id uuid,
  p_request_fingerprint bytea
)
returns table (
  organization_id uuid,
  device_id uuid,
  credential_id uuid,
  response_body jsonb
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    request.organization_id,
    request.device_id,
    request.proposed_credential_id,
    request.response_body
  from callora.pairing_code_resolutions as resolution
  join callora.device_credential_request_resolutions as request
    on request.organization_id = resolution.organization_id
   and request.pairing_code_id = resolution.pairing_code_id
   and request.request_id = p_request_id
   and request.operation = 'redeem'
   and request.request_fingerprint = p_request_fingerprint
  where resolution.code_hash = p_code_hash
$$;

revoke execute on function callora.resolve_pairing_redemption_replay(bytea, uuid, bytea)
  from public;

create or replace function callora.resolve_device_credential_replay(
  p_token_hash bytea,
  p_request_id uuid,
  p_operation text,
  p_request_fingerprint bytea
)
returns table (
  organization_id uuid,
  device_id uuid,
  credential_id uuid,
  lifecycle_state text,
  response_body jsonb
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    request.organization_id,
    request.device_id,
    request.credential_id,
    case
      when p_operation = 'activate' then 'consumed'
      when p_operation = 'revoke' then 'revoked'
      else 'active'
    end,
    request.response_body
  from callora.device_credential_request_resolutions as request
  where request.credential_token_hash = p_token_hash
    and request.request_id = p_request_id
    and request.operation = p_operation
    and request.request_fingerprint = p_request_fingerprint
    and p_operation in ('activate', 'rotation_prepare', 'rotation_confirm', 'reconsent', 'revoke')
$$;

revoke execute on function callora.resolve_device_credential_replay(
  bytea, uuid, text, bytea
) from public;

create or replace function callora.resolve_pending_rotation_credential(
  p_token_hash bytea,
  p_prepare_request_id uuid,
  p_confirm_request_id uuid,
  p_confirm_request_fingerprint bytea
)
returns table (
  organization_id uuid,
  device_id uuid,
  credential_id uuid,
  source_credential_id uuid,
  response_body jsonb
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    request.organization_id,
    request.device_id,
    request.proposed_credential_id,
    request.credential_id,
    request.response_body
  from callora.device_credential_request_resolutions as request
  join callora.device_credential_resolutions as credential
    on credential.organization_id = request.organization_id
   and credential.credential_id = request.proposed_credential_id
   and credential.token_hash = request.proposed_token_hash
   and credential.credential_type = 'session'
   and credential.lifecycle_state = 'pending'
   and credential.expires_at > statement_timestamp()
  where request.proposed_token_hash = p_token_hash
    and request.request_id = p_prepare_request_id
    and request.operation = 'rotation_prepare'
    and p_confirm_request_id <> p_prepare_request_id
    and octet_length(p_confirm_request_fingerprint) = 32
$$;

revoke execute on function callora.resolve_pending_rotation_credential(
  bytea, uuid, uuid, bytea
)
  from public;

create or replace function callora.prepare_device_credential_request(
  p_request_id uuid,
  p_organization_id uuid,
  p_employee_id uuid,
  p_device_id uuid,
  p_operation text,
  p_request_fingerprint bytea,
  p_proposed_credential_id uuid,
  p_proposed_token_hash bytea,
  p_expires_at timestamptz,
  p_source_credential_id uuid,
  p_pairing_code_id uuid,
  p_requested_at timestamptz
)
returns table (
  request_id uuid,
  credential_id uuid,
  lifecycle_state text,
  response_body jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_existing callora.device_credential_requests%rowtype;
  v_source callora.device_credentials%rowtype;
  v_source_token_hash bytea;
  v_device_mode text;
  v_device_platform text;
  v_pairing record;
  v_target_state text;
  v_credential_type text;
  v_response jsonb;
  v_withdrawn_count integer;
begin
  if callora.current_organization_id() is distinct from p_organization_id then
    raise exception 'organization context does not match credential request'
      using errcode = '42501';
  end if;
  if p_operation not in ('redeem', 'activate', 'rotation_prepare')
     or octet_length(p_request_fingerprint) <> 32
     or octet_length(p_proposed_token_hash) <> 32
     or p_expires_at <= p_requested_at then
    raise exception 'invalid credential request' using errcode = '22023';
  end if;

  -- Every transition locks employee, device, request, then credentials in UUID order.
  perform 1
  from callora.employees as employee
  where employee.organization_id = p_organization_id
    and employee.id = p_employee_id
    and (
      (p_operation = 'rotation_prepare' and employee.status = 'active')
      or (p_operation in ('redeem', 'activate') and employee.status in ('invited', 'active'))
    )
  for update;
  if not found then
    raise exception 'employee is not eligible for credential transition'
      using errcode = '55000';
  end if;

  select device.collection_mode, device.platform
    into v_device_mode, v_device_platform
  from callora.employee_devices as device
  where device.organization_id = p_organization_id
    and device.employee_id = p_employee_id
    and device.id = p_device_id
  for update;
  if not found then
    raise exception 'device is not owned by employee' using errcode = '23503';
  end if;

  select * into v_existing
  from callora.device_credential_requests as request
  where request.id = p_request_id
  for update;
  if found then
    if v_existing.organization_id is distinct from p_organization_id
       or v_existing.employee_id is distinct from p_employee_id
       or v_existing.device_id is distinct from p_device_id
       or v_existing.operation is distinct from p_operation
       or v_existing.request_fingerprint is distinct from p_request_fingerprint
       or v_existing.proposed_token_hash is distinct from p_proposed_token_hash
       or v_existing.credential_id is distinct from p_source_credential_id
       or v_existing.pairing_code_id is distinct from p_pairing_code_id then
      raise exception 'request id was reused with conflicting immutable metadata'
        using errcode = '23505';
    end if;
    return query select
      v_existing.id,
      v_existing.proposed_credential_id,
      v_existing.response_body ->> 'credentialState',
      v_existing.response_body,
      true;
    return;
  end if;

  if not exists (
    select 1
    from callora.mobile_collection_policies as policy
    where policy.platform = v_device_platform
      and policy.collection_mode = v_device_mode
      and policy.purpose = 'call_metadata'
      and policy.effective_at <= p_requested_at
      and (policy.retired_at is null or policy.retired_at > p_requested_at)
  ) then
    raise exception 'device platform and collection mode have no current policy'
      using errcode = '55000';
  end if;

  if p_operation = 'rotation_prepare' and not exists (
    select 1
    from callora.device_consent_receipts as receipt
    join lateral (
      select policy.id, policy.content_hash
      from callora.mobile_collection_policies as policy
      where policy.platform = v_device_platform
        and policy.collection_mode = v_device_mode
        and policy.purpose = 'call_metadata'
        and policy.effective_at <= p_requested_at
        and (policy.retired_at is null or policy.retired_at > p_requested_at)
      order by policy.effective_at desc, policy.id desc
      limit 1
    ) as current_policy
      on current_policy.id = receipt.policy_id
     and current_policy.content_hash = receipt.policy_content_hash
    where receipt.organization_id = p_organization_id
      and receipt.device_id = p_device_id
      and receipt.withdrawn_at is null
  ) then
    raise exception 'rotation requires consent to the current collection policy'
      using errcode = '55000';
  end if;

  if p_operation = 'redeem' then
    if p_source_credential_id is not null or p_pairing_code_id is null then
      raise exception 'redeem requires pairing code and no source credential'
        using errcode = '22023';
    end if;

    select
      pairing.employee_id,
      pairing.collection_mode,
      pairing.expires_at,
      pairing.consumed_at,
      pairing.consumed_by_device_id,
      pairing.revoked_at
    into v_pairing
    from callora.device_pairing_codes as pairing
    where pairing.organization_id = p_organization_id
      and pairing.id = p_pairing_code_id
    for update;

    if not found
       or v_pairing.employee_id is distinct from p_employee_id
       or v_pairing.collection_mode is distinct from v_device_mode
       or v_pairing.revoked_at is not null
       or v_pairing.expires_at <= p_requested_at
       or v_pairing.consumed_at is not null then
      raise exception 'pairing code cannot be redeemed' using errcode = '55000';
    end if;

    perform credential.id
    from callora.device_credentials as credential
    where credential.organization_id = p_organization_id
      and credential.device_id = p_device_id
    order by credential.id
    for update;

    update callora.device_pairing_codes
    set consumed_at = p_requested_at,
        consumed_by_device_id = p_device_id
    where organization_id = p_organization_id and id = p_pairing_code_id;

    update callora.device_credentials
    set lifecycle_state = 'revoked',
        revoked_at = p_requested_at,
        updated_at = p_requested_at
    where organization_id = p_organization_id
      and device_id = p_device_id
      and lifecycle_state in ('pending', 'active');

    update callora.device_consent_receipts
    set withdrawn_at = p_requested_at
    where organization_id = p_organization_id
      and device_id = p_device_id
      and withdrawn_at is null;
    get diagnostics v_withdrawn_count = row_count;

    update callora.employee_devices
    set status = 'pending',
        revoked_at = null,
        sync_state = 'never_synced',
        updated_at = p_requested_at
    where organization_id = p_organization_id and id = p_device_id;

    v_credential_type := 'bootstrap';
    v_target_state := 'active';
  else
    if p_source_credential_id is null or p_pairing_code_id is not null then
      raise exception 'credential transition requires a source credential'
        using errcode = '22023';
    end if;

    perform credential.id
    from callora.device_credentials as credential
    where credential.organization_id = p_organization_id
      and credential.device_id = p_device_id
    order by credential.id
    for update;

    if p_operation = 'rotation_prepare' then
      update callora.device_credentials
      set lifecycle_state = 'revoked',
          revoked_at = p_requested_at,
          updated_at = p_requested_at
      where organization_id = p_organization_id
        and device_id = p_device_id
        and credential_type = 'session'
        and lifecycle_state = 'pending'
        and expires_at <= p_requested_at;
    end if;

    select * into v_source
    from callora.device_credentials as credential
    where credential.organization_id = p_organization_id
      and credential.employee_id = p_employee_id
      and credential.device_id = p_device_id
      and credential.id = p_source_credential_id;
    if not found
       or v_source.lifecycle_state <> 'active'
       or v_source.expires_at <= p_requested_at
       or (p_operation = 'activate' and v_source.credential_type <> 'bootstrap')
       or (p_operation = 'rotation_prepare' and v_source.credential_type <> 'session') then
      raise exception 'source credential is not active for transition'
        using errcode = '55000';
    end if;
    v_source_token_hash := v_source.token_hash;
    v_credential_type := 'session';
    v_target_state := case
      when p_operation = 'rotation_prepare' then 'pending'
      else 'active'
    end;
  end if;

  v_response := jsonb_build_object(
    'requestId', p_request_id,
    'operation', p_operation,
    'credentialId', p_proposed_credential_id,
    'credentialState', v_target_state,
    'expiresAt', p_expires_at,
    'deviceId', p_device_id,
    'status', 'completed'
  );

  insert into callora.device_credential_requests (
    id, organization_id, employee_id, device_id,
    credential_id, credential_token_hash, pairing_code_id, parent_request_id,
    operation, request_fingerprint, proposed_credential_id,
    proposed_token_hash, response_body, completed_at, created_at, updated_at
  ) values (
    p_request_id, p_organization_id, p_employee_id, p_device_id,
    p_source_credential_id, v_source_token_hash, p_pairing_code_id, null,
    p_operation, p_request_fingerprint, p_proposed_credential_id,
    p_proposed_token_hash, v_response, p_requested_at, p_requested_at, p_requested_at
  );

  insert into callora.device_credentials (
    id, organization_id, employee_id, device_id, credential_type,
    token_hash, expires_at, rotated_from_credential_id,
    lifecycle_state, request_id, acknowledged_at, created_at, updated_at
  ) values (
    p_proposed_credential_id, p_organization_id, p_employee_id, p_device_id,
    v_credential_type, p_proposed_token_hash, p_expires_at,
    case when p_operation = 'rotation_prepare' then p_source_credential_id else null end,
    v_target_state, p_request_id,
    case when p_operation = 'activate' then p_requested_at else null end,
    p_requested_at, p_requested_at
  );

  if p_operation = 'activate' then
    update callora.device_credentials
    set lifecycle_state = 'consumed',
        consumed_at = p_requested_at,
        last_used_at = p_requested_at,
        updated_at = p_requested_at
    where organization_id = p_organization_id and id = p_source_credential_id;
  end if;

  perform callora.write_mobile_transition_evidence(
    p_organization_id,
    p_device_id,
    p_request_id,
    case p_operation
      when 'redeem' then 'device.credential_redeemed'
      when 'activate' then 'device.credential_activated'
      else 'device.session_rotation_prepared'
    end,
    case p_operation
      when 'redeem' then 'device.credential_redeemed'
      when 'activate' then 'device.credential_activated'
      else 'device.session_rotation_prepared'
    end,
    jsonb_build_object(
      'deviceId', p_device_id,
      'employeeId', p_employee_id,
      'credentialId', p_proposed_credential_id,
      'credentialState', v_target_state
    ),
    p_requested_at
  );

  if coalesce(v_withdrawn_count, 0) > 0 then
    perform callora.write_mobile_transition_evidence(
      p_organization_id, p_device_id, p_request_id,
      'device.consent_withdrawn', 'device.consent_withdrawn',
      jsonb_build_object('deviceId', p_device_id, 'reason', 're_pairing'),
      p_requested_at
    );
  end if;

  return query select
    p_request_id, p_proposed_credential_id, v_target_state, v_response, false;
end
$$;

revoke execute on function callora.prepare_device_credential_request(
  uuid, uuid, uuid, uuid, text, bytea, uuid, bytea,
  timestamptz, uuid, uuid, timestamptz
) from public;

create or replace function callora.confirm_device_session_rotation(
  p_confirm_request_id uuid,
  p_prepare_request_id uuid,
  p_organization_id uuid,
  p_employee_id uuid,
  p_device_id uuid,
  p_pending_credential_id uuid,
  p_request_fingerprint bytea,
  p_confirmed_at timestamptz
)
returns table (
  request_id uuid,
  credential_id uuid,
  lifecycle_state text,
  response_body jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_existing callora.device_credential_requests%rowtype;
  v_prepare callora.device_credential_requests%rowtype;
  v_pending callora.device_credentials%rowtype;
  v_source callora.device_credentials%rowtype;
  v_response jsonb;
begin
  if callora.current_organization_id() is distinct from p_organization_id then
    raise exception 'organization context does not match rotation confirmation'
      using errcode = '42501';
  end if;
  if p_confirm_request_id = p_prepare_request_id
     or octet_length(p_request_fingerprint) <> 32 then
    raise exception 'invalid rotation confirmation' using errcode = '22023';
  end if;

  perform 1
  from callora.employees as employee
  where employee.organization_id = p_organization_id
    and employee.id = p_employee_id
    and employee.status = 'active'
  for update;
  if not found then
    raise exception 'employee is not active for rotation confirmation'
      using errcode = '55000';
  end if;

  perform 1
  from callora.employee_devices as device
  where device.organization_id = p_organization_id
    and device.employee_id = p_employee_id
    and device.id = p_device_id
  for update;
  if not found then
    raise exception 'device is not owned by employee' using errcode = '23503';
  end if;

  select * into v_existing
  from callora.device_credential_requests as request
  where request.id = p_confirm_request_id
  for update;
  if found then
    if v_existing.organization_id is distinct from p_organization_id
       or v_existing.employee_id is distinct from p_employee_id
       or v_existing.device_id is distinct from p_device_id
       or v_existing.operation <> 'rotation_confirm'
       or v_existing.parent_request_id is distinct from p_prepare_request_id
       or v_existing.credential_id is distinct from p_pending_credential_id
       or v_existing.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'request id was reused with conflicting immutable metadata'
        using errcode = '23505';
    end if;
    return query select
      v_existing.id,
      v_existing.credential_id,
      'active'::text,
      v_existing.response_body,
      true;
    return;
  end if;

  select * into v_prepare
  from callora.device_credential_requests as request
  where request.organization_id = p_organization_id
    and request.device_id = p_device_id
    and request.id = p_prepare_request_id
  for update;
  if not found
     or v_prepare.operation <> 'rotation_prepare'
     or v_prepare.employee_id <> p_employee_id
     or v_prepare.proposed_credential_id <> p_pending_credential_id then
    raise exception 'rotation prepare request is not valid' using errcode = '55000';
  end if;

  perform credential.id
  from callora.device_credentials as credential
  where credential.organization_id = p_organization_id
    and credential.device_id = p_device_id
    and credential.id in (v_prepare.credential_id, p_pending_credential_id)
  order by credential.id
  for update;

  select * into v_pending
  from callora.device_credentials as credential
  where credential.organization_id = p_organization_id
    and credential.device_id = p_device_id
    and credential.id = p_pending_credential_id;
  select * into v_source
  from callora.device_credentials as credential
  where credential.organization_id = p_organization_id
    and credential.device_id = p_device_id
    and credential.id = v_prepare.credential_id;

  if v_pending.id is null
     or v_pending.employee_id <> p_employee_id
     or v_pending.credential_type <> 'session'
     or v_pending.lifecycle_state <> 'pending'
     or v_pending.request_id <> p_prepare_request_id
     or v_pending.rotated_from_credential_id <> v_source.id
     or v_pending.expires_at <= p_confirmed_at
     or v_source.id is null
     or v_source.lifecycle_state <> 'active'
     or v_source.credential_type <> 'session' then
    raise exception 'rotation credentials are not confirmable' using errcode = '55000';
  end if;

  update callora.device_credentials
  set lifecycle_state = 'revoked',
      revoked_at = p_confirmed_at,
      last_used_at = p_confirmed_at,
      updated_at = p_confirmed_at
  where organization_id = p_organization_id and id = v_source.id;

  update callora.device_credentials
  set lifecycle_state = 'active',
      acknowledged_at = p_confirmed_at,
      last_used_at = p_confirmed_at,
      updated_at = p_confirmed_at
  where organization_id = p_organization_id and id = v_pending.id;

  v_response := jsonb_build_object(
    'requestId', p_confirm_request_id,
    'operation', 'rotation_confirm',
    'credentialId', p_pending_credential_id,
    'credentialState', 'active',
    'previousCredentialId', v_source.id,
    'acknowledgedAt', p_confirmed_at,
    'deviceId', p_device_id,
    'status', 'completed'
  );

  insert into callora.device_credential_requests (
    id, organization_id, employee_id, device_id,
    credential_id, credential_token_hash, pairing_code_id, parent_request_id,
    operation, request_fingerprint, proposed_credential_id,
    proposed_token_hash, response_body, completed_at, created_at, updated_at
  ) values (
    p_confirm_request_id, p_organization_id, p_employee_id, p_device_id,
    p_pending_credential_id, v_pending.token_hash, null, p_prepare_request_id,
    'rotation_confirm', p_request_fingerprint, null,
    null, v_response, p_confirmed_at, p_confirmed_at, p_confirmed_at
  );

  perform callora.write_mobile_transition_evidence(
    p_organization_id, p_device_id, p_confirm_request_id,
    'device.session_rotation_confirmed', 'device.session_rotation_confirmed',
    jsonb_build_object(
      'deviceId', p_device_id,
      'credentialId', p_pending_credential_id,
      'previousCredentialId', v_source.id,
      'prepareRequestId', p_prepare_request_id
    ),
    p_confirmed_at
  );

  return query select
    p_confirm_request_id, p_pending_credential_id, 'active'::text,
    v_response, false;
end
$$;

revoke execute on function callora.confirm_device_session_rotation(
  uuid, uuid, uuid, uuid, uuid, uuid, bytea, timestamptz
) from public;

create or replace function callora.revoke_device_session_request(
  p_request_id uuid,
  p_organization_id uuid,
  p_employee_id uuid,
  p_device_id uuid,
  p_credential_id uuid,
  p_request_fingerprint bytea,
  p_revoked_at timestamptz
)
returns table (
  request_id uuid,
  credential_id uuid,
  lifecycle_state text,
  response_body jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_existing callora.device_credential_requests%rowtype;
  v_source callora.device_credentials%rowtype;
  v_response jsonb;
  v_withdrawn_count integer;
begin
  if callora.current_organization_id() is distinct from p_organization_id then
    raise exception 'organization context does not match session revocation'
      using errcode = '42501';
  end if;
  if octet_length(p_request_fingerprint) <> 32 then
    raise exception 'invalid revocation request fingerprint' using errcode = '22023';
  end if;

  perform 1
  from callora.employees as employee
  where employee.organization_id = p_organization_id
    and employee.id = p_employee_id
  for update;
  if not found then
    raise exception 'employee does not exist for session revocation'
      using errcode = '23503';
  end if;

  perform 1
  from callora.employee_devices as device
  where device.organization_id = p_organization_id
    and device.employee_id = p_employee_id
    and device.id = p_device_id
  for update;
  if not found then
    raise exception 'device is not owned by employee' using errcode = '23503';
  end if;

  select * into v_existing
  from callora.device_credential_requests as request
  where request.id = p_request_id
  for update;
  if found then
    if v_existing.organization_id is distinct from p_organization_id
       or v_existing.employee_id is distinct from p_employee_id
       or v_existing.device_id is distinct from p_device_id
       or v_existing.operation <> 'revoke'
       or v_existing.credential_id is distinct from p_credential_id
       or v_existing.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'request id was reused with conflicting immutable metadata'
        using errcode = '23505';
    end if;
    return query select
      v_existing.id, v_existing.credential_id, 'revoked'::text,
      v_existing.response_body, true;
    return;
  end if;

  perform credential.id
  from callora.device_credentials as credential
  where credential.organization_id = p_organization_id
    and credential.device_id = p_device_id
  order by credential.id
  for update;

  select * into v_source
  from callora.device_credentials as credential
  where credential.organization_id = p_organization_id
    and credential.employee_id = p_employee_id
    and credential.device_id = p_device_id
    and credential.id = p_credential_id;
  if not found
     or v_source.credential_type <> 'session'
     or v_source.lifecycle_state <> 'active' then
    raise exception 'session is not active' using errcode = '55000';
  end if;

  update callora.device_credentials
  set lifecycle_state = 'revoked',
      revoked_at = p_revoked_at,
      last_used_at = case when id = p_credential_id then p_revoked_at else last_used_at end,
      updated_at = p_revoked_at
  where organization_id = p_organization_id
    and device_id = p_device_id
    and lifecycle_state in ('pending', 'active');

  update callora.device_consent_receipts
  set withdrawn_at = p_revoked_at
  where organization_id = p_organization_id
    and device_id = p_device_id
    and withdrawn_at is null;
  get diagnostics v_withdrawn_count = row_count;

  update callora.employee_devices
  set status = 'revoked',
      revoked_at = p_revoked_at,
      updated_at = p_revoked_at
  where organization_id = p_organization_id and id = p_device_id;

  v_response := jsonb_build_object(
    'requestId', p_request_id,
    'operation', 'revoke',
    'credentialId', p_credential_id,
    'credentialState', 'revoked',
    'revokedAt', p_revoked_at,
    'deviceId', p_device_id,
    'status', 'completed'
  );

  insert into callora.device_credential_requests (
    id, organization_id, employee_id, device_id,
    credential_id, credential_token_hash, pairing_code_id, parent_request_id,
    operation, request_fingerprint, proposed_credential_id,
    proposed_token_hash, response_body, completed_at, created_at, updated_at
  ) values (
    p_request_id, p_organization_id, p_employee_id, p_device_id,
    p_credential_id, v_source.token_hash, null, null,
    'revoke', p_request_fingerprint, null,
    null, v_response, p_revoked_at, p_revoked_at, p_revoked_at
  );

  perform callora.write_mobile_transition_evidence(
    p_organization_id, p_device_id, p_request_id,
    'device.session_revoked', 'device.session_revoked',
    jsonb_build_object(
      'deviceId', p_device_id,
      'employeeId', p_employee_id,
      'credentialId', p_credential_id,
      'reason', 'self_revocation'
    ),
    p_revoked_at
  );

  if v_withdrawn_count > 0 then
    perform callora.write_mobile_transition_evidence(
      p_organization_id, p_device_id, p_request_id,
      'device.consent_withdrawn', 'device.consent_withdrawn',
      jsonb_build_object('deviceId', p_device_id, 'reason', 'self_revocation'),
      p_revoked_at
    );
  end if;

  return query select
    p_request_id, p_credential_id, 'revoked'::text, v_response, false;
end
$$;

revoke execute on function callora.revoke_device_session_request(
  uuid, uuid, uuid, uuid, uuid, bytea, timestamptz
) from public;

create or replace function callora.accept_device_collection_policy(
  p_request_id uuid,
  p_organization_id uuid,
  p_employee_id uuid,
  p_device_id uuid,
  p_session_credential_id uuid,
  p_request_fingerprint bytea,
  p_policy_id uuid,
  p_policy_content_hash bytea,
  p_permissions jsonb,
  p_locale text,
  p_accepted_at timestamptz,
  p_recorded_at timestamptz
)
returns table (consent_receipt_id uuid, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_device_mode text;
  v_device_platform text;
  v_request callora.device_credential_requests%rowtype;
  v_policy callora.mobile_collection_policies%rowtype;
  v_existing_receipt callora.device_consent_receipts%rowtype;
  v_receipt_id uuid;
begin
  if callora.current_organization_id() is distinct from p_organization_id then
    raise exception 'organization context does not match consent acceptance'
      using errcode = '42501';
  end if;
  if octet_length(p_request_fingerprint) <> 32
     or octet_length(p_policy_content_hash) <> 32 then
    raise exception 'invalid policy content hash' using errcode = '22023';
  end if;

  perform 1
  from callora.employees as employee
  where employee.organization_id = p_organization_id
    and employee.id = p_employee_id
    and employee.status in ('invited', 'active')
  for update;
  if not found then
    raise exception 'employee is not eligible for activation consent'
      using errcode = '55000';
  end if;

  select device.collection_mode, device.platform
    into v_device_mode, v_device_platform
  from callora.employee_devices as device
  where device.organization_id = p_organization_id
    and device.employee_id = p_employee_id
    and device.id = p_device_id
  for update;
  if not found then
    raise exception 'device is not owned by employee' using errcode = '23503';
  end if;

  select * into v_request
  from callora.device_credential_requests as request
  where request.organization_id = p_organization_id
    and request.device_id = p_device_id
    and request.id = p_request_id
  for update;
  if not found
     or v_request.operation <> 'activate'
     or v_request.employee_id <> p_employee_id
     or v_request.proposed_credential_id <> p_session_credential_id
     or v_request.request_fingerprint <> p_request_fingerprint then
    raise exception 'activation request is not valid for consent'
      using errcode = '55000';
  end if;

  perform credential.id
  from callora.device_credentials as credential
  where credential.organization_id = p_organization_id
    and credential.device_id = p_device_id
    and credential.id = p_session_credential_id
  for update;

  if not exists (
    select 1 from callora.device_credentials as credential
    where credential.organization_id = p_organization_id
      and credential.device_id = p_device_id
      and credential.id = p_session_credential_id
      and credential.credential_type = 'session'
      and credential.lifecycle_state = 'active'
  ) then
    raise exception 'activation session is not active' using errcode = '55000';
  end if;

  select * into v_policy
  from callora.mobile_collection_policies as policy
  where policy.platform = v_device_platform
    and policy.collection_mode = v_device_mode
    and policy.purpose = 'call_metadata'
    and policy.effective_at <= p_recorded_at
    and (policy.retired_at is null or policy.retired_at > p_recorded_at)
  order by policy.effective_at desc, policy.id desc
  limit 1;
  if not found
     or v_policy.id <> p_policy_id
     or v_policy.content_hash <> p_policy_content_hash then
    raise exception 'collection policy is not current for device mode'
      using errcode = '23503';
  end if;

  select * into v_existing_receipt
  from callora.device_consent_receipts as receipt
  where receipt.organization_id = p_organization_id
    and receipt.device_id = p_device_id
    and receipt.withdrawn_at is null
  for update;
  if found then
    if v_existing_receipt.policy_id = p_policy_id
       and v_existing_receipt.policy_content_hash = p_policy_content_hash
       and v_existing_receipt.permissions = p_permissions
       and v_existing_receipt.accepted_at = p_accepted_at then
      return query select v_existing_receipt.id, true;
      return;
    end if;
    raise exception 'device already has a different active consent receipt'
      using errcode = '23505';
  end if;

  insert into callora.device_consent_receipts (
    organization_id, employee_id, device_id,
    policy_id, policy_content_hash, policy_version, disclosure_version,
    purpose, permissions, locale, accepted_at, recorded_at, created_at, updated_at
  ) values (
    p_organization_id, p_employee_id, p_device_id,
    v_policy.id, v_policy.content_hash, v_policy.policy_version, v_policy.disclosure_version,
    v_policy.purpose, p_permissions, p_locale, p_accepted_at, p_recorded_at,
    p_recorded_at, p_recorded_at
  ) returning id into v_receipt_id;

  update callora.employee_devices
  set status = 'connected',
      call_log_permission = p_permissions ->> 'callLog',
      phone_state_permission = p_permissions ->> 'phoneState',
      contacts_permission = p_permissions ->> 'contacts',
      notifications_permission = p_permissions ->> 'notifications',
      recording_files_permission = p_permissions ->> 'recordingFiles',
      background_execution_permission = p_permissions ->> 'backgroundExecution',
      last_seen_at = p_recorded_at,
      revoked_at = null,
      updated_at = p_recorded_at
  where organization_id = p_organization_id and id = p_device_id;

  update callora.employees
  set status = 'active', updated_at = p_recorded_at
  where organization_id = p_organization_id and id = p_employee_id
    and status in ('invited', 'active');

  perform callora.write_mobile_transition_evidence(
    p_organization_id, p_device_id, p_request_id,
    'device.consent_accepted', 'device.consent_accepted',
    jsonb_build_object(
      'deviceId', p_device_id,
      'employeeId', p_employee_id,
      'consentReceiptId', v_receipt_id,
      'policyId', v_policy.id,
      'policyContentHash', encode(v_policy.content_hash, 'hex')
    ),
    p_recorded_at
  );
  perform callora.write_mobile_transition_evidence(
    p_organization_id, p_device_id, p_request_id,
    'device.activated', 'device.activated',
    jsonb_build_object(
      'deviceId', p_device_id,
      'employeeId', p_employee_id,
      'credentialId', p_session_credential_id,
      'consentReceiptId', v_receipt_id
    ),
    p_recorded_at
  );

  return query select v_receipt_id, false;
end
$$;

revoke execute on function callora.accept_device_collection_policy(
  uuid, uuid, uuid, uuid, uuid, bytea, uuid, bytea, jsonb,
  text, timestamptz, timestamptz
) from public;

create or replace function callora.reconsent_device_collection_policy(
  p_request_id uuid,
  p_organization_id uuid,
  p_employee_id uuid,
  p_device_id uuid,
  p_credential_id uuid,
  p_request_fingerprint bytea,
  p_policy_id uuid,
  p_policy_content_hash bytea,
  p_permissions jsonb,
  p_locale text,
  p_accepted_at timestamptz,
  p_recorded_at timestamptz
)
returns table (consent_receipt_id uuid, response_body jsonb, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_device_mode text;
  v_device_platform text;
  v_existing callora.device_credential_requests%rowtype;
  v_source callora.device_credentials%rowtype;
  v_policy callora.mobile_collection_policies%rowtype;
  v_receipt_id uuid;
  v_response jsonb;
  v_withdrawn_count integer;
begin
  if callora.current_organization_id() is distinct from p_organization_id then
    raise exception 'organization context does not match reconsent request'
      using errcode = '42501';
  end if;
  if octet_length(p_request_fingerprint) <> 32
     or octet_length(p_policy_content_hash) <> 32 then
    raise exception 'invalid reconsent request' using errcode = '22023';
  end if;

  perform 1
  from callora.employees as employee
  where employee.organization_id = p_organization_id
    and employee.id = p_employee_id
    and employee.status = 'active'
  for update;
  if not found then
    raise exception 'employee is not active for reconsent'
      using errcode = '55000';
  end if;

  select device.collection_mode, device.platform
    into v_device_mode, v_device_platform
  from callora.employee_devices as device
  where device.organization_id = p_organization_id
    and device.employee_id = p_employee_id
    and device.id = p_device_id
  for update;
  if not found then
    raise exception 'device is not owned by employee' using errcode = '23503';
  end if;

  select * into v_existing
  from callora.device_credential_requests as request
  where request.id = p_request_id
  for update;
  if found then
    if v_existing.organization_id is distinct from p_organization_id
       or v_existing.employee_id is distinct from p_employee_id
       or v_existing.device_id is distinct from p_device_id
       or v_existing.operation <> 'reconsent'
       or v_existing.credential_id is distinct from p_credential_id
       or v_existing.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'request id was reused with conflicting immutable metadata'
        using errcode = '23505';
    end if;
    return query select
      (v_existing.response_body ->> 'consentReceiptId')::uuid,
      v_existing.response_body,
      true;
    return;
  end if;

  perform credential.id
  from callora.device_credentials as credential
  where credential.organization_id = p_organization_id
    and credential.device_id = p_device_id
  order by credential.id
  for update;
  select * into v_source
  from callora.device_credentials as credential
  where credential.organization_id = p_organization_id
    and credential.employee_id = p_employee_id
    and credential.device_id = p_device_id
    and credential.id = p_credential_id;
  if not found
     or v_source.credential_type <> 'session'
     or v_source.lifecycle_state <> 'active'
     or v_source.expires_at <= p_recorded_at then
    raise exception 'session is not active for reconsent' using errcode = '55000';
  end if;

  select * into v_policy
  from callora.mobile_collection_policies as policy
  where policy.platform = v_device_platform
    and policy.collection_mode = v_device_mode
    and policy.purpose = 'call_metadata'
    and policy.effective_at <= p_recorded_at
    and (policy.retired_at is null or policy.retired_at > p_recorded_at)
  order by policy.effective_at desc, policy.id desc
  limit 1;
  if not found
     or v_policy.id <> p_policy_id
     or v_policy.content_hash <> p_policy_content_hash then
    raise exception 'collection policy is not current for device mode'
      using errcode = '23503';
  end if;

  update callora.device_consent_receipts
  set withdrawn_at = p_recorded_at
  where organization_id = p_organization_id
    and device_id = p_device_id
    and withdrawn_at is null;
  get diagnostics v_withdrawn_count = row_count;

  insert into callora.device_consent_receipts (
    organization_id, employee_id, device_id,
    policy_id, policy_content_hash, policy_version, disclosure_version,
    purpose, permissions, locale, accepted_at, recorded_at, created_at, updated_at
  ) values (
    p_organization_id, p_employee_id, p_device_id,
    v_policy.id, v_policy.content_hash, v_policy.policy_version, v_policy.disclosure_version,
    v_policy.purpose, p_permissions, p_locale, p_accepted_at, p_recorded_at,
    p_recorded_at, p_recorded_at
  ) returning id into v_receipt_id;

  update callora.employee_devices
  set call_log_permission = p_permissions ->> 'callLog',
      phone_state_permission = p_permissions ->> 'phoneState',
      contacts_permission = p_permissions ->> 'contacts',
      notifications_permission = p_permissions ->> 'notifications',
      recording_files_permission = p_permissions ->> 'recordingFiles',
      background_execution_permission = p_permissions ->> 'backgroundExecution',
      updated_at = p_recorded_at
  where organization_id = p_organization_id and id = p_device_id;

  v_response := jsonb_build_object(
    'requestId', p_request_id,
    'operation', 'reconsent',
    'credentialId', p_credential_id,
    'consentReceiptId', v_receipt_id,
    'policyId', v_policy.id,
    'policyContentHash', encode(v_policy.content_hash, 'hex'),
    'completedAt', p_recorded_at,
    'deviceId', p_device_id,
    'status', 'completed'
  );

  insert into callora.device_credential_requests (
    id, organization_id, employee_id, device_id,
    credential_id, credential_token_hash, pairing_code_id, parent_request_id,
    operation, request_fingerprint, proposed_credential_id,
    proposed_token_hash, response_body, completed_at, created_at, updated_at
  ) values (
    p_request_id, p_organization_id, p_employee_id, p_device_id,
    p_credential_id, v_source.token_hash, null, null,
    'reconsent', p_request_fingerprint, null,
    null, v_response, p_recorded_at, p_recorded_at, p_recorded_at
  );

  if v_withdrawn_count > 0 then
    perform callora.write_mobile_transition_evidence(
      p_organization_id, p_device_id, p_request_id,
      'device.consent_withdrawn', 'device.consent_withdrawn',
      jsonb_build_object('deviceId', p_device_id, 'reason', 'reconsent'),
      p_recorded_at
    );
  end if;
  perform callora.write_mobile_transition_evidence(
    p_organization_id, p_device_id, p_request_id,
    'device.consent_accepted', 'device.consent_accepted',
    jsonb_build_object(
      'deviceId', p_device_id,
      'employeeId', p_employee_id,
      'consentReceiptId', v_receipt_id,
      'policyId', v_policy.id,
      'policyContentHash', encode(v_policy.content_hash, 'hex'),
      'reason', 'reconsent'
    ),
    p_recorded_at
  );

  return query select v_receipt_id, v_response, false;
end
$$;

revoke execute on function callora.reconsent_device_collection_policy(
  uuid, uuid, uuid, uuid, uuid, bytea, uuid, bytea, jsonb,
  text, timestamptz, timestamptz
) from public;

create or replace function callora.device_has_current_collection_consent(
  p_organization_id uuid,
  p_device_id uuid,
  p_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    p_organization_id = callora.current_organization_id()
    and exists (
      select 1
      from callora.employee_devices as device
      join callora.device_consent_receipts as receipt
        on receipt.organization_id = device.organization_id
       and receipt.device_id = device.id
       and receipt.withdrawn_at is null
      join lateral (
        select policy.id, policy.content_hash
        from callora.mobile_collection_policies as policy
        where policy.platform = device.platform
          and policy.collection_mode = device.collection_mode
          and policy.purpose = 'call_metadata'
          and policy.effective_at <= p_at
          and (policy.retired_at is null or policy.retired_at > p_at)
        order by policy.effective_at desc, policy.id desc
        limit 1
      ) as current_policy
        on current_policy.id = receipt.policy_id
       and current_policy.content_hash = receipt.policy_content_hash
      where device.organization_id = p_organization_id
        and device.id = p_device_id
    )
$$;

revoke execute on function callora.device_has_current_collection_consent(
  uuid, uuid, timestamptz
) from public;

create or replace function callora.withdraw_device_consent(
  p_organization_id uuid,
  p_device_id uuid,
  p_request_id uuid,
  p_reason text,
  p_withdrawn_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_withdrawn_count integer;
begin
  if callora.current_organization_id() is distinct from p_organization_id then
    raise exception 'organization context does not match consent withdrawal'
      using errcode = '42501';
  end if;
  if char_length(btrim(p_reason)) not between 1 and 64 then
    raise exception 'consent withdrawal reason is invalid' using errcode = '22023';
  end if;

  perform 1
  from callora.employee_devices as device
  where device.organization_id = p_organization_id and device.id = p_device_id
  for update;
  if not found then return false; end if;

  update callora.device_consent_receipts
  set withdrawn_at = p_withdrawn_at
  where organization_id = p_organization_id
    and device_id = p_device_id
    and withdrawn_at is null;
  get diagnostics v_withdrawn_count = row_count;
  if v_withdrawn_count = 0 then return false; end if;

  perform callora.write_mobile_transition_evidence(
    p_organization_id, p_device_id, p_request_id,
    'device.consent_withdrawn', 'device.consent_withdrawn',
    jsonb_build_object('deviceId', p_device_id, 'reason', p_reason),
    p_withdrawn_at
  );
  return true;
end
$$;

revoke execute on function callora.withdraw_device_consent(
  uuid, uuid, uuid, text, timestamptz
) from public;

create or replace function callora.reset_mobile_rate_limit(
  p_key_hash bytea,
  p_operation text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_deleted integer;
  v_bucket smallint;
begin
  if octet_length(p_key_hash) <> 32
     or p_operation !~ '^[a-z][a-z_]{0,63}$' then
    raise exception 'invalid mobile rate-limit key' using errcode = '22023';
  end if;
  v_bucket := ((get_byte(p_key_hash, 0) * 256 + get_byte(p_key_hash, 1)) % 64)::smallint;
  perform pg_advisory_xact_lock(914203, v_bucket::integer);
  delete from callora.mobile_rate_limits
  where key_hash = p_key_hash and operation = p_operation;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end
$$;

revoke execute on function callora.reset_mobile_rate_limit(bytea, text) from public;

create or replace function callora.touch_active_device_credential(
  p_organization_id uuid,
  p_credential_id uuid,
  p_used_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_updated integer;
begin
  if callora.current_organization_id() is distinct from p_organization_id then
    raise exception 'organization context does not match credential use'
      using errcode = '42501';
  end if;
  update callora.device_credentials
  set last_used_at = greatest(coalesce(last_used_at, p_used_at), p_used_at),
      updated_at = greatest(updated_at, p_used_at)
  where organization_id = p_organization_id
    and id = p_credential_id
    and lifecycle_state = 'active';
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end
$$;

revoke execute on function callora.touch_active_device_credential(
  uuid, uuid, timestamptz
) from public;

alter table callora.device_credential_requests enable row level security;
alter table callora.device_credential_requests force row level security;
create policy device_credential_requests_tenant_isolation on callora.device_credential_requests
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));
