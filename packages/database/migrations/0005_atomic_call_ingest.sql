-- Register a bounded mobile batch. Reusing a batch id with different immutable
-- metadata is rejected instead of silently accepting a conflicting payload.
create or replace function callora.register_call_ingest_batch(
  p_organization_id uuid,
  p_employee_id uuid,
  p_device_id uuid,
  p_batch_id text,
  p_sent_at timestamptz,
  p_item_count integer,
  p_schema_version smallint default 1,
  p_previous_cursor text default null,
  p_payload_sha256 bytea default null
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  registered_batch_id uuid;
begin
  if callora.current_organization_id() is distinct from p_organization_id then
    raise exception 'organization context does not match ingest batch'
      using errcode = '42501';
  end if;

  insert into callora.call_ingest_batches as existing_batch (
    organization_id,
    employee_id,
    device_id,
    batch_id,
    schema_version,
    previous_cursor,
    payload_sha256,
    item_count,
    sent_at
  ) values (
    p_organization_id,
    p_employee_id,
    p_device_id,
    p_batch_id,
    p_schema_version,
    p_previous_cursor,
    p_payload_sha256,
    p_item_count,
    p_sent_at
  )
  on conflict on constraint call_ingest_batches_device_batch_key
  do update set
    last_received_at = clock_timestamp(),
    attempt_count = existing_batch.attempt_count + 1
  where existing_batch.employee_id = excluded.employee_id
    and existing_batch.schema_version = excluded.schema_version
    and existing_batch.item_count = excluded.item_count
    and existing_batch.sent_at = excluded.sent_at
    and existing_batch.previous_cursor is not distinct from excluded.previous_cursor
    and existing_batch.payload_sha256 is not distinct from excluded.payload_sha256
  returning existing_batch.id into registered_batch_id;

  if registered_batch_id is null then
    raise exception 'batch id was reused with conflicting immutable metadata'
      using errcode = '23505';
  end if;

  return registered_batch_id;
end
$$;

-- One call to this function is one atomic insert-or-update. The unique
-- (organization_id, device_id, external_id) constraint serializes concurrent
-- retries. An unchanged or stale retry returns "duplicate" without a write.
create or replace function callora.upsert_mobile_call(
  p_organization_id uuid,
  p_employee_id uuid,
  p_device_id uuid,
  p_external_id text,
  p_direction text,
  p_disposition text,
  p_phone_number text,
  p_started_at timestamptz,
  p_duration_seconds integer,
  p_ingest_batch_id uuid default null,
  p_sim_card_id uuid default null,
  p_native_call_id text default null,
  p_contact_name text default null,
  p_answered_at timestamptz default null,
  p_ended_at timestamptz default null,
  p_ring_duration_seconds integer default null,
  p_is_internal boolean default false,
  p_is_within_working_hours boolean default false,
  p_recording_status text default 'not_expected',
  p_native_last_modified_at timestamptz default null
)
returns table (call_log_id uuid, outcome text)
language plpgsql
security invoker
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
    p_phone_number,
    p_contact_name,
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

  update callora.call_logs as existing_call
  set
    employee_id = p_employee_id,
    sim_card_id = p_sim_card_id,
    ingest_batch_id = coalesce(p_ingest_batch_id, existing_call.ingest_batch_id),
    native_call_id = p_native_call_id,
    direction = p_direction,
    disposition = p_disposition,
    phone_number = p_phone_number,
    contact_name = p_contact_name,
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
    and existing_call.device_id = p_device_id
    and existing_call.external_id = p_external_id
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
      existing_call.phone_number,
      existing_call.contact_name,
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
      p_phone_number,
      p_contact_name,
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

  select existing_call.id
    into affected_call_log_id
  from callora.call_logs as existing_call
  where existing_call.organization_id = p_organization_id
    and existing_call.device_id = p_device_id
    and existing_call.external_id = p_external_id;

  if affected_call_log_id is null then
    raise exception 'call retry conflict resolved without a visible row'
      using errcode = '40001';
  end if;

  return query select affected_call_log_id, 'duplicate'::text;
end
$$;

revoke execute on function callora.register_call_ingest_batch(
  uuid, uuid, uuid, text, timestamptz, integer, smallint, text, bytea
) from public;
revoke execute on function callora.upsert_mobile_call(
  uuid, uuid, uuid, text, text, text, text, timestamptz, integer,
  uuid, uuid, text, text, timestamptz, timestamptz, integer, boolean,
  boolean, text, timestamptz
) from public;
