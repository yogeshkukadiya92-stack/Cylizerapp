-- Application-layer envelope encryption for call participant PII.
--
-- Encryption and blind-index keys never enter PostgreSQL. During the bounded
-- migration window a row is either legacy plaintext-only or encrypted-only;
-- both representations on one row are rejected so a completed backfill cannot
-- accidentally retain recoverable plaintext.

alter table callora.call_logs
  drop constraint call_logs_phone_number_not_blank,
  alter column phone_number drop not null,
  add column pii_encryption_version smallint,
  add column pii_key_version integer,
  add column phone_number_ciphertext bytea,
  add column phone_number_nonce bytea,
  add column phone_number_blind_index bytea,
  add column contact_name_ciphertext bytea,
  add column contact_name_nonce bytea,
  add column contact_name_blind_index bytea,
  add column pii_encrypted_at timestamptz,
  add constraint call_logs_pii_representation_valid check (
    (
      -- Legacy rows remain readable only until the explicit backfill completes.
      pii_encryption_version is null
      and pii_key_version is null
      and pii_encrypted_at is null
      and phone_number is not null
      and btrim(phone_number) <> ''
      and phone_number_ciphertext is null
      and phone_number_nonce is null
      and phone_number_blind_index is null
      and contact_name_ciphertext is null
      and contact_name_nonce is null
      and contact_name_blind_index is null
    )
    or
    (
      -- Format 1 is AES-256-GCM with the 16-byte tag appended to ciphertext.
      pii_encryption_version is not null
      and pii_encryption_version = 1
      and pii_key_version is not null
      and pii_key_version > 0
      and pii_encrypted_at is not null
      and phone_number is null
      and contact_name is null
      and phone_number_ciphertext is not null
      and octet_length(phone_number_ciphertext) between 17 and 65552
      and phone_number_nonce is not null
      and octet_length(phone_number_nonce) = 12
      and phone_number_blind_index is not null
      and octet_length(phone_number_blind_index) = 32
      and (
        (
          contact_name_ciphertext is null
          and contact_name_nonce is null
          and contact_name_blind_index is null
        )
        or
        (
          contact_name_ciphertext is not null
          and octet_length(contact_name_ciphertext) between 16 and 65552
          and contact_name_nonce is not null
          and octet_length(contact_name_nonce) = 12
          and contact_name_blind_index is not null
          and octet_length(contact_name_blind_index) = 32
        )
      )
    )
  )
  not valid;

-- Full-table constraint validation and the plaintext-to-blind-index transition
-- are intentionally deferred to the idempotent non-transactional migration.
-- That stage uses PostgreSQL's CONCURRENTLY form so a production-scale table
-- does not take an avoidable write-blocking index lock.

-- Reassert the existing tenant boundary and deny accidental PUBLIC access to
-- both legacy and encrypted representations. Application roles remain governed
-- by the explicit grants in access/roles.sql and the forced tenant policy.
alter table callora.call_logs enable row level security;
alter table callora.call_logs force row level security;
revoke all on callora.call_logs from public;

comment on column callora.call_logs.pii_encryption_version is
  'Application envelope format; version 1 is AES-256-GCM with an appended 128-bit tag.';
comment on column callora.call_logs.pii_key_version is
  'External application keyring version; key material is never stored in PostgreSQL.';
comment on column callora.call_logs.phone_number_blind_index is
  'Tenant- and field-bound HMAC for exact phone lookup; not an unkeyed hash.';
comment on column callora.call_logs.contact_name_blind_index is
  'Tenant- and field-bound HMAC for exact contact lookup; not an unkeyed hash.';

-- New writes use encrypted envelopes only. The row UUID is supplied by the
-- application so AES-GCM AAD can bind the ciphertext to the final database row
-- even when concurrent retries race on the mobile external identity.
create or replace function callora.upsert_mobile_call_encrypted(
  p_call_log_id uuid,
  p_organization_id uuid,
  p_employee_id uuid,
  p_device_id uuid,
  p_external_id text,
  p_direction text,
  p_disposition text,
  p_phone_number_ciphertext bytea,
  p_phone_number_nonce bytea,
  p_phone_number_blind_index bytea,
  p_pii_encryption_version smallint,
  p_pii_key_version integer,
  p_pii_encrypted_at timestamptz,
  p_started_at timestamptz,
  p_duration_seconds integer,
  p_ingest_batch_id uuid,
  p_sim_card_id uuid,
  p_native_call_id text,
  p_contact_name_ciphertext bytea,
  p_contact_name_nonce bytea,
  p_contact_name_blind_index bytea,
  p_answered_at timestamptz,
  p_ended_at timestamptz,
  p_ring_duration_seconds integer,
  p_is_internal boolean,
  p_is_within_working_hours boolean,
  p_recording_status text,
  p_native_last_modified_at timestamptz
)
returns table (call_log_id uuid, outcome text)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  affected_call_log_id uuid;
begin
  if callora.current_organization_id() is distinct from p_organization_id then
    raise exception 'organization context does not match call log'
      using errcode = '42501';
  end if;

  insert into callora.call_logs (
    id,
    organization_id,
    employee_id,
    device_id,
    sim_card_id,
    ingest_batch_id,
    external_id,
    native_call_id,
    source,
    direction,
    disposition,
    phone_number,
    contact_name,
    pii_encryption_version,
    pii_key_version,
    phone_number_ciphertext,
    phone_number_nonce,
    phone_number_blind_index,
    contact_name_ciphertext,
    contact_name_nonce,
    contact_name_blind_index,
    pii_encrypted_at,
    is_internal,
    started_at,
    answered_at,
    ended_at,
    duration_seconds,
    ring_duration_seconds,
    is_within_working_hours,
    recording_status,
    native_last_modified_at
  ) values (
    p_call_log_id,
    p_organization_id,
    p_employee_id,
    p_device_id,
    p_sim_card_id,
    p_ingest_batch_id,
    p_external_id,
    p_native_call_id,
    'mobile_call_log',
    p_direction,
    p_disposition,
    null,
    null,
    p_pii_encryption_version,
    p_pii_key_version,
    p_phone_number_ciphertext,
    p_phone_number_nonce,
    p_phone_number_blind_index,
    p_contact_name_ciphertext,
    p_contact_name_nonce,
    p_contact_name_blind_index,
    p_pii_encrypted_at,
    p_is_internal,
    p_started_at,
    p_answered_at,
    p_ended_at,
    p_duration_seconds,
    p_ring_duration_seconds,
    p_is_within_working_hours,
    p_recording_status,
    p_native_last_modified_at
  )
  on conflict on constraint call_logs_device_external_key do nothing
  returning id into affected_call_log_id;

  if affected_call_log_id is not null then
    return query select affected_call_log_id, 'created'::text;
    return;
  end if;

  select existing_call.id
    into affected_call_log_id
  from callora.call_logs as existing_call
  where existing_call.organization_id = p_organization_id
    and existing_call.device_id = p_device_id
    and existing_call.external_id = p_external_id
  for update;

  if affected_call_log_id is null then
    raise exception 'call retry conflict resolved without a visible row'
      using errcode = '40001';
  end if;
  if affected_call_log_id <> p_call_log_id then
    raise exception 'call-log encryption row identity changed during upsert'
      using errcode = '40001';
  end if;

  update callora.call_logs as existing_call
  set
    employee_id = p_employee_id,
    sim_card_id = p_sim_card_id,
    ingest_batch_id = coalesce(p_ingest_batch_id, existing_call.ingest_batch_id),
    native_call_id = p_native_call_id,
    direction = p_direction,
    disposition = p_disposition,
    phone_number = null,
    contact_name = null,
    pii_encryption_version = p_pii_encryption_version,
    pii_key_version = p_pii_key_version,
    phone_number_ciphertext = p_phone_number_ciphertext,
    phone_number_nonce = p_phone_number_nonce,
    phone_number_blind_index = p_phone_number_blind_index,
    contact_name_ciphertext = p_contact_name_ciphertext,
    contact_name_nonce = p_contact_name_nonce,
    contact_name_blind_index = p_contact_name_blind_index,
    pii_encrypted_at = p_pii_encrypted_at,
    is_internal = p_is_internal,
    started_at = p_started_at,
    answered_at = p_answered_at,
    ended_at = p_ended_at,
    duration_seconds = p_duration_seconds,
    ring_duration_seconds = p_ring_duration_seconds,
    is_within_working_hours = p_is_within_working_hours,
    recording_status = p_recording_status,
    native_last_modified_at = p_native_last_modified_at
  where existing_call.organization_id = p_organization_id
    and existing_call.id = p_call_log_id
    and (
      p_native_last_modified_at is null
      or existing_call.native_last_modified_at is null
      or p_native_last_modified_at >= existing_call.native_last_modified_at
    )
    and row(
      existing_call.employee_id,
      existing_call.sim_card_id,
      existing_call.ingest_batch_id,
      existing_call.native_call_id,
      existing_call.direction,
      existing_call.disposition,
      existing_call.pii_encryption_version,
      existing_call.pii_key_version,
      existing_call.phone_number_blind_index,
      existing_call.contact_name_blind_index,
      existing_call.is_internal,
      existing_call.started_at,
      existing_call.answered_at,
      existing_call.ended_at,
      existing_call.duration_seconds,
      existing_call.ring_duration_seconds,
      existing_call.is_within_working_hours,
      existing_call.recording_status,
      existing_call.native_last_modified_at
    ) is distinct from row(
      p_employee_id,
      p_sim_card_id,
      coalesce(p_ingest_batch_id, existing_call.ingest_batch_id),
      p_native_call_id,
      p_direction,
      p_disposition,
      p_pii_encryption_version,
      p_pii_key_version,
      p_phone_number_blind_index,
      p_contact_name_blind_index,
      p_is_internal,
      p_started_at,
      p_answered_at,
      p_ended_at,
      p_duration_seconds,
      p_ring_duration_seconds,
      p_is_within_working_hours,
      p_recording_status,
      p_native_last_modified_at
    )
  returning existing_call.id into affected_call_log_id;

  if affected_call_log_id is not null then
    return query select affected_call_log_id, 'updated'::text;
    return;
  end if;

  return query select p_call_log_id, 'duplicate'::text;
end
$$;

revoke execute on function callora.upsert_mobile_call_encrypted(
  uuid, uuid, uuid, uuid, text, text, text, bytea, bytea, bytea,
  smallint, integer, timestamptz, timestamptz, integer, uuid, uuid, text,
  bytea, bytea, bytea, timestamptz, timestamptz, integer, boolean, boolean,
  text, timestamptz
) from public;

-- Manual API ingestion is also function-only. There are deliberately no
-- plaintext parameters, and runtime roles receive no direct call_logs DML.
create or replace function callora.insert_manual_call_encrypted(
  p_call_log_id uuid,
  p_organization_id uuid,
  p_employee_id uuid,
  p_device_id uuid,
  p_external_id text,
  p_direction text,
  p_disposition text,
  p_pii_encryption_version smallint,
  p_pii_key_version integer,
  p_phone_number_ciphertext bytea,
  p_phone_number_nonce bytea,
  p_phone_number_blind_index bytea,
  p_contact_name_ciphertext bytea,
  p_contact_name_nonce bytea,
  p_contact_name_blind_index bytea,
  p_pii_encrypted_at timestamptz,
  p_is_internal boolean,
  p_started_at timestamptz,
  p_answered_at timestamptz,
  p_ended_at timestamptz,
  p_duration_seconds integer,
  p_ring_duration_seconds integer,
  p_is_within_working_hours boolean,
  p_ingest_fingerprint text,
  p_occurred_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  inserted_call_log_id uuid;
begin
  if callora.current_organization_id() is distinct from p_organization_id then
    raise exception 'organization context does not match call log'
      using errcode = '42501';
  end if;

  insert into callora.call_logs (
    id, organization_id, employee_id, device_id, external_id, source,
    direction, disposition, pii_encryption_version, pii_key_version,
    phone_number_ciphertext, phone_number_nonce, phone_number_blind_index,
    contact_name_ciphertext, contact_name_nonce, contact_name_blind_index,
    pii_encrypted_at, is_internal, started_at, answered_at, ended_at,
    duration_seconds, ring_duration_seconds, is_within_working_hours,
    recording_status, ingest_fingerprint, created_at, updated_at
  ) values (
    p_call_log_id, p_organization_id, p_employee_id, p_device_id,
    p_external_id, 'manual', p_direction, p_disposition,
    p_pii_encryption_version, p_pii_key_version,
    p_phone_number_ciphertext, p_phone_number_nonce, p_phone_number_blind_index,
    p_contact_name_ciphertext, p_contact_name_nonce, p_contact_name_blind_index,
    p_pii_encrypted_at, p_is_internal, p_started_at, p_answered_at, p_ended_at,
    p_duration_seconds, p_ring_duration_seconds, p_is_within_working_hours,
    'not_expected', p_ingest_fingerprint, p_occurred_at, p_occurred_at
  )
  on conflict do nothing
  returning id into inserted_call_log_id;

  return inserted_call_log_id;
end
$$;

revoke execute on function callora.insert_manual_call_encrypted(
  uuid, uuid, uuid, uuid, text, text, text, smallint, integer,
  bytea, bytea, bytea, bytea, bytea, bytea, timestamptz, boolean,
  timestamptz, timestamptz, timestamptz, integer, integer, boolean, text,
  timestamptz
) from public;

-- A temporary migrator cannot lock call_logs directly because it deliberately
-- has no UPDATE privilege. This narrow claim function acquires bounded row locks
-- in the caller's transaction and returns only the legacy PII needed to encrypt.
create or replace function callora.claim_call_pii_backfill_batch(
  p_organization_id uuid,
  p_batch_size integer
)
returns table (
  id uuid,
  organization_id uuid,
  phone_number text,
  contact_name text
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if callora.current_organization_id() is distinct from p_organization_id then
    raise exception 'organization context does not match call log'
      using errcode = '42501';
  end if;
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 500 then
    raise exception 'call PII backfill batch size is invalid'
      using errcode = '22023';
  end if;

  return query
  select
    call_log.id,
    call_log.organization_id,
    call_log.phone_number,
    call_log.contact_name
  from callora.call_logs as call_log
  where call_log.organization_id = p_organization_id
    and call_log.pii_encryption_version is null
    and call_log.phone_number is not null
  order by call_log.id
  for update of call_log skip locked
  limit p_batch_size;
end
$$;

revoke execute on function callora.claim_call_pii_backfill_batch(uuid, integer)
  from public;

-- The temporary PII migrator can read a locked legacy row but cannot UPDATE the
-- table directly. This one-way transition always clears plaintext in the same
-- statement that writes the authenticated envelope.
create or replace function callora.backfill_call_pii_encrypted(
  p_organization_id uuid,
  p_call_log_id uuid,
  p_pii_encryption_version smallint,
  p_pii_key_version integer,
  p_phone_number_ciphertext bytea,
  p_phone_number_nonce bytea,
  p_phone_number_blind_index bytea,
  p_contact_name_ciphertext bytea,
  p_contact_name_nonce bytea,
  p_contact_name_blind_index bytea,
  p_pii_encrypted_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  transitioned_count integer;
begin
  if callora.current_organization_id() is distinct from p_organization_id then
    raise exception 'organization context does not match call log'
      using errcode = '42501';
  end if;

  update callora.call_logs
  set phone_number = null,
      contact_name = null,
      pii_encryption_version = p_pii_encryption_version,
      pii_key_version = p_pii_key_version,
      phone_number_ciphertext = p_phone_number_ciphertext,
      phone_number_nonce = p_phone_number_nonce,
      phone_number_blind_index = p_phone_number_blind_index,
      contact_name_ciphertext = p_contact_name_ciphertext,
      contact_name_nonce = p_contact_name_nonce,
      contact_name_blind_index = p_contact_name_blind_index,
      pii_encrypted_at = p_pii_encrypted_at,
      updated_at = p_pii_encrypted_at
  where organization_id = p_organization_id
    and id = p_call_log_id
    and pii_encryption_version is null
    and phone_number is not null;

  get diagnostics transitioned_count = row_count;
  return transitioned_count = 1;
end
$$;

revoke execute on function callora.backfill_call_pii_encrypted(
  uuid, uuid, smallint, integer, bytea, bytea, bytea, bytea, bytea, bytea,
  timestamptz
) from public;
