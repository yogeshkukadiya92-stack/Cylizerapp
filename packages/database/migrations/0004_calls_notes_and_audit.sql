create table callora.call_ingest_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_id uuid not null,
  device_id uuid not null,
  batch_id text not null,
  schema_version smallint not null default 1,
  previous_cursor text,
  next_cursor text,
  payload_sha256 bytea,
  item_count integer not null,
  processed_item_count integer not null default 0,
  status text not null default 'received',
  sent_at timestamptz not null,
  received_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  last_received_at timestamptz not null default statement_timestamp(),
  attempt_count integer not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint call_ingest_batches_employee_fk foreign key (organization_id, employee_id)
    references callora.employees (organization_id, id) on delete restrict,
  constraint call_ingest_batches_device_fk foreign key (organization_id, device_id)
    references callora.employee_devices (organization_id, id) on delete restrict,
  constraint call_ingest_batches_organization_id_key unique (organization_id, id),
  constraint call_ingest_batches_device_id_key unique (organization_id, device_id, id),
  constraint call_ingest_batches_device_batch_key unique (organization_id, device_id, batch_id),
  constraint call_ingest_batches_batch_id_not_blank check (btrim(batch_id) <> ''),
  constraint call_ingest_batches_schema_version_valid check (schema_version > 0),
  constraint call_ingest_batches_payload_hash_length
    check (payload_sha256 is null or octet_length(payload_sha256) = 32),
  constraint call_ingest_batches_item_count_valid check (item_count between 0 and 500),
  constraint call_ingest_batches_processed_count_valid
    check (processed_item_count between 0 and item_count),
  constraint call_ingest_batches_status_valid
    check (status in ('received', 'processing', 'completed', 'partial', 'rejected')),
  constraint call_ingest_batches_completion_valid check (
    (status in ('completed', 'partial', 'rejected')) = (completed_at is not null)
  ),
  constraint call_ingest_batches_completed_at_valid
    check (completed_at is null or completed_at >= received_at),
  constraint call_ingest_batches_last_received_at_valid
    check (last_received_at >= received_at),
  constraint call_ingest_batches_attempt_count_valid check (attempt_count > 0)
);

create index call_ingest_batches_employee_received_idx
  on callora.call_ingest_batches (organization_id, employee_id, received_at desc, id desc);
create index call_ingest_batches_device_status_idx
  on callora.call_ingest_batches (organization_id, device_id, status, received_at, id)
  where status in ('received', 'processing');

create trigger call_ingest_batches_touch_updated_at
before update on callora.call_ingest_batches
for each row execute function callora.touch_updated_at();

create table callora.call_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_id uuid not null,
  device_id uuid,
  sim_card_id uuid,
  ingest_batch_id uuid,
  external_id text,
  native_call_id text,
  source text not null,
  direction text not null,
  disposition text not null,
  phone_number text not null,
  contact_name text,
  is_internal boolean not null default false,
  started_at timestamptz not null,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer not null default 0,
  ring_duration_seconds integer,
  is_within_working_hours boolean not null default false,
  recording_status text not null default 'not_expected',
  is_pinned boolean not null default false,
  native_last_modified_at timestamptz,
  ingested_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint call_logs_employee_fk foreign key (organization_id, employee_id)
    references callora.employees (organization_id, id) on delete restrict,
  constraint call_logs_device_fk foreign key (organization_id, device_id)
    references callora.employee_devices (organization_id, id) on delete restrict,
  constraint call_logs_sim_card_fk foreign key (organization_id, device_id, sim_card_id)
    references callora.sim_cards (organization_id, device_id, id) on delete restrict,
  constraint call_logs_ingest_batch_fk foreign key (organization_id, device_id, ingest_batch_id)
    references callora.call_ingest_batches (organization_id, device_id, id) on delete restrict,
  constraint call_logs_organization_id_key unique (organization_id, id),
  constraint call_logs_device_external_key unique (organization_id, device_id, external_id),
  constraint call_logs_mobile_identity_required check (
    source <> 'mobile_call_log' or (device_id is not null and external_id is not null)
  ),
  constraint call_logs_sim_requires_device check (sim_card_id is null or device_id is not null),
  constraint call_logs_external_id_not_blank check (external_id is null or btrim(external_id) <> ''),
  constraint call_logs_source_valid
    check (source in ('mobile_call_log', 'manual', 'telephony_provider', 'import')),
  constraint call_logs_direction_valid check (direction in ('incoming', 'outgoing')),
  constraint call_logs_disposition_valid
    check (disposition in ('answered', 'missed', 'rejected', 'busy', 'blocked', 'voicemail', 'unknown')),
  constraint call_logs_phone_number_not_blank check (btrim(phone_number) <> ''),
  constraint call_logs_answered_at_valid check (answered_at is null or answered_at >= started_at),
  constraint call_logs_ended_at_valid check (
    ended_at is null
    or ended_at >= coalesce(answered_at, started_at)
  ),
  constraint call_logs_duration_valid check (duration_seconds >= 0),
  constraint call_logs_ring_duration_valid
    check (ring_duration_seconds is null or ring_duration_seconds >= 0),
  constraint call_logs_recording_status_valid
    check (recording_status in ('not_expected', 'pending', 'uploading', 'available', 'failed', 'deleted'))
);

-- Supports stable descending keyset pagination: (started_at, id) < (:cursor_at, :cursor_id).
create index call_logs_tenant_started_keyset_idx
  on callora.call_logs (organization_id, started_at desc, id desc)
  include (employee_id, direction, disposition, duration_seconds);
create index call_logs_employee_started_keyset_idx
  on callora.call_logs (organization_id, employee_id, started_at desc, id desc)
  include (direction, disposition, duration_seconds);
create index call_logs_phone_started_keyset_idx
  on callora.call_logs (organization_id, phone_number, started_at desc, id desc);
create index call_logs_device_modified_idx
  on callora.call_logs (organization_id, device_id, native_last_modified_at desc, id desc)
  where native_last_modified_at is not null;
create index call_logs_sim_card_idx
  on callora.call_logs (organization_id, device_id, sim_card_id)
  where sim_card_id is not null;
create index call_logs_ingest_batch_idx
  on callora.call_logs (organization_id, device_id, ingest_batch_id, id)
  where ingest_batch_id is not null;
create index call_logs_attention_keyset_idx
  on callora.call_logs (organization_id, started_at desc, id desc)
  where disposition in ('missed', 'rejected', 'busy');
create index call_logs_pinned_keyset_idx
  on callora.call_logs (organization_id, started_at desc, id desc)
  where is_pinned = true;

create trigger call_logs_touch_updated_at
before update on callora.call_logs
for each row execute function callora.touch_updated_at();

create table callora.call_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  call_log_id uuid not null,
  author_user_id uuid not null,
  body text not null,
  is_pinned boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint call_notes_call_log_fk foreign key (organization_id, call_log_id)
    references callora.call_logs (organization_id, id) on delete cascade,
  constraint call_notes_author_fk foreign key (organization_id, author_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint call_notes_organization_id_key unique (organization_id, id),
  constraint call_notes_body_length check (char_length(btrim(body)) between 1 and 10000)
);

create index call_notes_call_created_idx
  on callora.call_notes (organization_id, call_log_id, created_at desc, id desc);
create index call_notes_author_created_idx
  on callora.call_notes (organization_id, author_user_id, created_at desc, id desc);
create index call_notes_pinned_idx
  on callora.call_notes (organization_id, call_log_id, created_at desc, id desc)
  where is_pinned = true;

create trigger call_notes_touch_updated_at
before update on callora.call_notes
for each row execute function callora.touch_updated_at();

create table callora.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  actor_user_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  request_id text,
  source_ip inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  constraint audit_events_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete restrict,
  constraint audit_events_actor_fk foreign key (organization_id, actor_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint audit_events_organization_id_key unique (organization_id, id),
  constraint audit_events_action_format check (action ~ '^[a-z]+(\.[a-z_]+)+$'),
  constraint audit_events_entity_type_format check (entity_type ~ '^[a-z][a-z_]*$'),
  constraint audit_events_request_id_not_blank check (request_id is null or btrim(request_id) <> ''),
  constraint audit_events_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index audit_events_tenant_occurred_keyset_idx
  on callora.audit_events (organization_id, occurred_at desc, id desc)
  include (actor_user_id, action, entity_type, entity_id);
create index audit_events_actor_occurred_idx
  on callora.audit_events (organization_id, actor_user_id, occurred_at desc, id desc)
  where actor_user_id is not null;
create index audit_events_entity_occurred_idx
  on callora.audit_events (organization_id, entity_type, entity_id, occurred_at desc, id desc)
  where entity_id is not null;

create or replace function callora.reject_audit_event_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  raise exception 'audit events are append-only' using errcode = '55000';
end
$$;

create trigger audit_events_append_only
before update or delete on callora.audit_events
for each row execute function callora.reject_audit_event_mutation();

revoke execute on function callora.reject_audit_event_mutation() from public;
