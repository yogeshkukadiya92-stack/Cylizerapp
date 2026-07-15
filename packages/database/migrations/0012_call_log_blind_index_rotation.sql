-- Persist blind-index key versions and add bounded encrypted-envelope rotation.
--
-- Existing format-1 envelopes were produced by the former singleton blind key.
-- They are assigned version 1 without rewriting ciphertext; the application
-- retains the exact legacy AAD/HMAC derivation for that version. New format-2
-- envelopes authenticate the blind-index key version in AES-GCM AAD.

alter table callora.call_logs
  add column pii_blind_index_key_version integer;

update callora.call_logs
set pii_blind_index_key_version = 1
where pii_encryption_version is not null;

-- Keep old 0011 signatures and plaintext seed/import rows safe while instances
-- roll. A format-1 writer always means legacy blind key v1; plaintext always
-- means no blind key. A new format-2 insert gets a temporary v1 marker so the
-- explicit-version wrapper can replace it atomically before returning. Updates
-- preserve an existing format-2 version until that wrapper replaces it.
create or replace function callora.normalize_call_pii_blind_index_key_version()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.pii_encryption_version is null then
    new.pii_blind_index_key_version := null;
  elsif new.pii_encryption_version = 1 then
    new.pii_blind_index_key_version := 1;
  elsif new.pii_encryption_version = 2 and new.pii_blind_index_key_version is null then
    new.pii_blind_index_key_version := 1;
  end if;
  return new;
end
$$;

revoke execute on function callora.normalize_call_pii_blind_index_key_version()
  from public;

create trigger normalize_call_pii_blind_index_key_version
before insert or update of pii_encryption_version, pii_blind_index_key_version,
  phone_number_ciphertext, phone_number_blind_index,
  contact_name_ciphertext, contact_name_blind_index
on callora.call_logs
for each row execute function callora.normalize_call_pii_blind_index_key_version();

alter table callora.call_logs
  drop constraint call_logs_pii_representation_valid,
  add constraint call_logs_pii_representation_valid check (
    (
      pii_encryption_version is null
      and pii_key_version is null
      and pii_blind_index_key_version is null
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
      (
        (pii_encryption_version = 1 and pii_blind_index_key_version = 1)
        or
        (pii_encryption_version = 2 and pii_blind_index_key_version > 0)
      )
      and pii_key_version is not null
      and pii_key_version > 0
      and pii_blind_index_key_version is not null
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
  ) not valid;

comment on column callora.call_logs.pii_blind_index_key_version is
  'External version for both tenant-bound blind indexes; format 2 authenticates it in AES-GCM AAD.';

-- Rolling-compatible mobile overload. The 0011 implementation remains the
-- only place that performs the large upsert; this wrapper atomically persists
-- and verifies the explicit blind-index key version before returning.
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
  p_pii_blind_index_key_version integer,
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
  write_result record;
begin
  if p_pii_blind_index_key_version is null or p_pii_blind_index_key_version < 1 then
    raise exception 'blind-index key version is invalid' using errcode = '22023';
  end if;

  select legacy.call_log_id, legacy.outcome
    into strict write_result
  from callora.upsert_mobile_call_encrypted(
    p_call_log_id, p_organization_id, p_employee_id, p_device_id,
    p_external_id, p_direction, p_disposition,
    p_phone_number_ciphertext, p_phone_number_nonce, p_phone_number_blind_index,
    p_pii_encryption_version, p_pii_key_version, p_pii_encrypted_at,
    p_started_at, p_duration_seconds, p_ingest_batch_id, p_sim_card_id,
    p_native_call_id, p_contact_name_ciphertext, p_contact_name_nonce,
    p_contact_name_blind_index, p_answered_at, p_ended_at,
    p_ring_duration_seconds, p_is_internal, p_is_within_working_hours,
    p_recording_status, p_native_last_modified_at
  ) as legacy;

  if write_result.outcome <> 'duplicate' then
    update callora.call_logs
    set pii_blind_index_key_version = p_pii_blind_index_key_version
    where organization_id = p_organization_id
      and id = write_result.call_log_id;
  end if;

  if not exists (
    select 1
    from callora.call_logs
    where organization_id = p_organization_id
      and id = write_result.call_log_id
      and pii_blind_index_key_version = p_pii_blind_index_key_version
  ) then
    raise exception 'call-log blind-index key version conflicts with stored envelope'
      using errcode = '40001';
  end if;

  return query select write_result.call_log_id::uuid, write_result.outcome::text;
end
$$;

revoke execute on function callora.upsert_mobile_call_encrypted(
  uuid, uuid, uuid, uuid, text, text, text, bytea, bytea, bytea,
  smallint, integer, integer, timestamptz, timestamptz, integer, uuid, uuid,
  text, bytea, bytea, bytea, timestamptz, timestamptz, integer, boolean,
  boolean, text, timestamptz
) from public;

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
  p_pii_blind_index_key_version integer,
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
  if p_pii_blind_index_key_version is null or p_pii_blind_index_key_version < 1 then
    raise exception 'blind-index key version is invalid' using errcode = '22023';
  end if;

  inserted_call_log_id := callora.insert_manual_call_encrypted(
    p_call_log_id, p_organization_id, p_employee_id, p_device_id,
    p_external_id, p_direction, p_disposition, p_pii_encryption_version,
    p_pii_key_version, p_phone_number_ciphertext, p_phone_number_nonce,
    p_phone_number_blind_index, p_contact_name_ciphertext,
    p_contact_name_nonce, p_contact_name_blind_index, p_pii_encrypted_at,
    p_is_internal, p_started_at, p_answered_at, p_ended_at,
    p_duration_seconds, p_ring_duration_seconds, p_is_within_working_hours,
    p_ingest_fingerprint, p_occurred_at
  );

  if inserted_call_log_id is not null then
    update callora.call_logs
    set pii_blind_index_key_version = p_pii_blind_index_key_version
    where organization_id = p_organization_id
      and id = inserted_call_log_id;
    if not found then
      raise exception 'inserted call-log envelope disappeared' using errcode = '40001';
    end if;
  end if;
  return inserted_call_log_id;
end
$$;

revoke execute on function callora.insert_manual_call_encrypted(
  uuid, uuid, uuid, uuid, text, text, text, smallint, integer, integer,
  bytea, bytea, bytea, bytea, bytea, bytea, timestamptz, boolean,
  timestamptz, timestamptz, timestamptz, integer, integer, boolean, text,
  timestamptz
) from public;

create or replace function callora.backfill_call_pii_encrypted(
  p_organization_id uuid,
  p_call_log_id uuid,
  p_pii_encryption_version smallint,
  p_pii_key_version integer,
  p_pii_blind_index_key_version integer,
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
  transitioned boolean;
begin
  if p_pii_blind_index_key_version is null or p_pii_blind_index_key_version < 1 then
    raise exception 'blind-index key version is invalid' using errcode = '22023';
  end if;

  transitioned := callora.backfill_call_pii_encrypted(
    p_organization_id, p_call_log_id, p_pii_encryption_version,
    p_pii_key_version, p_phone_number_ciphertext, p_phone_number_nonce,
    p_phone_number_blind_index, p_contact_name_ciphertext,
    p_contact_name_nonce, p_contact_name_blind_index, p_pii_encrypted_at
  );
  if transitioned then
    update callora.call_logs
    set pii_blind_index_key_version = p_pii_blind_index_key_version
    where organization_id = p_organization_id
      and id = p_call_log_id;
    if not found then
      raise exception 'backfilled call-log envelope disappeared' using errcode = '40001';
    end if;
  end if;
  return transitioned;
end
$$;

revoke execute on function callora.backfill_call_pii_encrypted(
  uuid, uuid, smallint, integer, integer, bytea, bytea, bytea, bytea, bytea,
  bytea, timestamptz
) from public;

-- Multiple short-lived workers may re-encrypt different rows without blocking.
-- No plaintext is returned; the application authenticates/decrypts the old
-- envelope and produces a fresh nonce plus active encryption/blind versions.
create or replace function callora.claim_call_pii_rotation_batch(
  p_organization_id uuid,
  p_target_pii_encryption_version smallint,
  p_target_pii_key_version integer,
  p_target_blind_index_key_version integer,
  p_batch_size integer
)
returns table (
  id uuid,
  organization_id uuid,
  pii_encryption_version smallint,
  pii_key_version integer,
  pii_blind_index_key_version integer,
  phone_number_ciphertext bytea,
  phone_number_nonce bytea,
  phone_number_blind_index bytea,
  contact_name_ciphertext bytea,
  contact_name_nonce bytea,
  contact_name_blind_index bytea
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if callora.current_organization_id() is distinct from p_organization_id then
    raise exception 'organization context does not match call log' using errcode = '42501';
  end if;
  if p_target_pii_encryption_version is distinct from 2 or
      p_target_pii_key_version is null or p_target_pii_key_version < 1 or
      p_target_blind_index_key_version is null or p_target_blind_index_key_version < 1 then
    raise exception 'call PII rotation target is invalid' using errcode = '22023';
  end if;
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 500 then
    raise exception 'call PII rotation batch size is invalid' using errcode = '22023';
  end if;

  return query
  select
    call_log.id,
    call_log.organization_id,
    call_log.pii_encryption_version,
    call_log.pii_key_version,
    call_log.pii_blind_index_key_version,
    call_log.phone_number_ciphertext,
    call_log.phone_number_nonce,
    call_log.phone_number_blind_index,
    call_log.contact_name_ciphertext,
    call_log.contact_name_nonce,
    call_log.contact_name_blind_index
  from callora.call_logs as call_log
  where call_log.organization_id = p_organization_id
    and call_log.pii_encryption_version is not null
    and (
      call_log.pii_encryption_version <> p_target_pii_encryption_version
      or call_log.pii_key_version <> p_target_pii_key_version
      or call_log.pii_blind_index_key_version <> p_target_blind_index_key_version
    )
  order by call_log.id
  for update of call_log skip locked
  limit p_batch_size;
end
$$;

revoke execute on function callora.claim_call_pii_rotation_batch(
  uuid, smallint, integer, integer, integer
) from public;

create or replace function callora.rotate_call_pii_encrypted(
  p_organization_id uuid,
  p_call_log_id uuid,
  p_expected_pii_encryption_version smallint,
  p_expected_pii_key_version integer,
  p_expected_blind_index_key_version integer,
  p_pii_encryption_version smallint,
  p_pii_key_version integer,
  p_pii_blind_index_key_version integer,
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
  rotated_count integer;
begin
  if callora.current_organization_id() is distinct from p_organization_id then
    raise exception 'organization context does not match call log' using errcode = '42501';
  end if;
  if p_pii_encryption_version is distinct from 2 or
      p_pii_key_version is null or p_pii_key_version < 1 or
      p_pii_blind_index_key_version is null or p_pii_blind_index_key_version < 1 then
    raise exception 'call PII rotation target is invalid' using errcode = '22023';
  end if;

  update callora.call_logs
  set pii_encryption_version = p_pii_encryption_version,
      pii_key_version = p_pii_key_version,
      pii_blind_index_key_version = p_pii_blind_index_key_version,
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
    and pii_encryption_version = p_expected_pii_encryption_version
    and pii_key_version = p_expected_pii_key_version
    and pii_blind_index_key_version = p_expected_blind_index_key_version
    and phone_number is null
    and contact_name is null;

  get diagnostics rotated_count = row_count;
  return rotated_count = 1;
end
$$;

revoke execute on function callora.rotate_call_pii_encrypted(
  uuid, uuid, smallint, integer, integer, smallint, integer, integer,
  bytea, bytea, bytea, bytea, bytea, bytea, timestamptz
) from public;
