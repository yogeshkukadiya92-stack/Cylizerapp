-- Deterministic, rerunnable development data for tenant-isolation testing.
-- Pairing hashes are synthetic and must never be reused outside local development.
begin;

select set_config('app.current_organization_id', '10000000-0000-4000-8000-000000000001', true);
select set_config('app.current_user_id', '10000000-0000-4000-8000-000000000101', true);

insert into callora.organizations (
  id, name, slug, status, plan, industry, support_email, primary_phone,
  time_zone, default_country_code, trial_ends_at
) values (
  '10000000-0000-4000-8000-000000000001',
  'Aster Sales Labs',
  'aster-sales-labs',
  'active',
  'growth',
  'Business services',
  'ops@aster.test',
  '+919100000001',
  'Asia/Kolkata',
  '+91',
  clock_timestamp() + interval '30 days'
)
on conflict (id) do update set
  name = excluded.name,
  status = excluded.status,
  plan = excluded.plan,
  trial_ends_at = excluded.trial_ends_at;

insert into callora.users (
  id, organization_id, email, display_name, phone_number, status
) values (
  '10000000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000001',
  'owner@aster.test',
  'Aarav Shah',
  '+919100000101',
  'active'
)
on conflict (id) do update set
  display_name = excluded.display_name,
  phone_number = excluded.phone_number,
  status = excluded.status;

insert into callora.user_identities (
  id, organization_id, user_id, provider, issuer, subject, email_at_link_time
) values (
  '10000000-0000-4000-8000-000000000151',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000101',
  'oidc',
  'https://identity.callora.test',
  'oidc-aster-owner',
  'owner@aster.test'
)
on conflict (organization_id, issuer, subject) do update set
  user_id = excluded.user_id,
  email_at_link_time = excluded.email_at_link_time;

insert into callora.roles (
  id, organization_id, name, description, system_key, is_editable
) values (
  '10000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000001',
  'Owner',
  'Development tenant owner.',
  'owner',
  false
)
on conflict (id) do update set description = excluded.description;

insert into callora.organization_memberships (
  id, organization_id, user_id, status, invited_at, joined_at
) values (
  '10000000-0000-4000-8000-000000000301',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000101',
  'active',
  statement_timestamp(),
  statement_timestamp()
)
on conflict (id) do update set
  status = excluded.status,
  joined_at = coalesce(callora.organization_memberships.joined_at, excluded.joined_at);

insert into callora.role_permissions (organization_id, role_id, permission_key)
select
  '10000000-0000-4000-8000-000000000001'::uuid,
  '10000000-0000-4000-8000-000000000201'::uuid,
  permission_key
from callora.permission_definitions
on conflict do nothing;

insert into callora.membership_roles (organization_id, membership_id, role_id) values (
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000301',
  '10000000-0000-4000-8000-000000000201'
)
on conflict do nothing;

insert into callora.teams (id, organization_id, name, description) values (
  '10000000-0000-4000-8000-000000000401',
  '10000000-0000-4000-8000-000000000001',
  'Inside Sales',
  'Inbound and outbound sales calls.'
)
on conflict (id) do update set description = excluded.description;

insert into callora.employees (
  id, organization_id, linked_user_id, team_id, employee_code, display_name,
  email, primary_phone, job_title, status, working_time_zone,
  working_week_days, working_day_starts_at, working_day_ends_at
) values (
  '10000000-0000-4000-8000-000000000501',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000401',
  'AST-001',
  'Aarav Shah',
  'owner@aster.test',
  '+919100000101',
  'Sales lead',
  'active',
  'Asia/Kolkata',
  array[1, 2, 3, 4, 5, 6]::smallint[],
  '09:00',
  '18:00'
)
on conflict (id) do update set
  team_id = excluded.team_id,
  display_name = excluded.display_name,
  status = excluded.status;

insert into callora.employee_devices (
  id, organization_id, employee_id, installation_id, platform, manufacturer,
  model, os_version, app_version, status, sync_state, call_log_permission,
  phone_state_permission, contacts_permission, notifications_permission,
  recording_files_permission, background_execution_permission, last_seen_at,
  registered_at, last_successful_sync_at
) values (
  '10000000-0000-4000-8000-000000000601',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000501',
  'dev-aster-pixel-01',
  'android',
  'Google',
  'Pixel Dev',
  '15',
  '0.1.0',
  'connected',
  'idle',
  'granted',
  'granted',
  'granted',
  'granted',
  'granted',
  'granted',
  statement_timestamp(),
  statement_timestamp(),
  statement_timestamp()
)
on conflict (id) do update set
  app_version = excluded.app_version,
  status = excluded.status,
  sync_state = excluded.sync_state,
  last_seen_at = excluded.last_seen_at,
  last_successful_sync_at = excluded.last_successful_sync_at;

insert into callora.sim_cards (
  id, organization_id, device_id, slot_index, carrier_name, phone_number, subscription_id
) values (
  '10000000-0000-4000-8000-000000000701',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000601',
  0,
  'Local Dev Carrier',
  '+919100000101',
  'aster-sim-0'
)
on conflict (id) do update set phone_number = excluded.phone_number;

insert into callora.device_pairing_codes (
  id, organization_id, employee_id, code_hash, code_hint,
  created_by_user_id, expires_at
) values (
  '10000000-0000-4000-8000-000000000801',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000501',
  digest('CALLORA-ASTER-DEV-PAIR', 'sha256'),
  'A101',
  '10000000-0000-4000-8000-000000000101',
  clock_timestamp() + interval '7 days'
)
on conflict (id) do update set
  expires_at = excluded.expires_at,
  revoked_at = null;

insert into callora.call_ingest_batches (
  id, organization_id, employee_id, device_id, batch_id, payload_sha256,
  item_count, processed_item_count, status, sent_at, completed_at
) values (
  '10000000-0000-4000-8000-000000000901',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000501',
  '10000000-0000-4000-8000-000000000601',
  'aster-batch-001',
  digest('aster-batch-001', 'sha256'),
  1,
  1,
  'completed',
  clock_timestamp() - interval '15 minutes',
  statement_timestamp()
)
on conflict (id) do update set
  processed_item_count = excluded.processed_item_count,
  status = excluded.status,
  completed_at = excluded.completed_at;

insert into callora.call_logs (
  id, organization_id, employee_id, device_id, sim_card_id, ingest_batch_id,
  external_id, native_call_id, source, direction, disposition, phone_number,
  contact_name, started_at, answered_at, ended_at, duration_seconds,
  ring_duration_seconds, is_within_working_hours, native_last_modified_at
) values (
  '10000000-0000-4000-8000-000000000a01',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000501',
  '10000000-0000-4000-8000-000000000601',
  '10000000-0000-4000-8000-000000000701',
  '10000000-0000-4000-8000-000000000901',
  'aster-call-001',
  'native-1001',
  'mobile_call_log',
  'outgoing',
  'answered',
  '+919811110001',
  'Dev Customer A',
  clock_timestamp() - interval '15 minutes',
  clock_timestamp() - interval '14 minutes 55 seconds',
  clock_timestamp() - interval '10 minutes',
  295,
  5,
  true,
  clock_timestamp() - interval '10 minutes'
)
on conflict (id) do update set
  disposition = excluded.disposition,
  duration_seconds = excluded.duration_seconds,
  native_last_modified_at = excluded.native_last_modified_at;

insert into callora.call_notes (
  id, organization_id, call_log_id, author_user_id, body, is_pinned
) values (
  '10000000-0000-4000-8000-000000000b01',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000a01',
  '10000000-0000-4000-8000-000000000101',
  'Requested a product demo next week.',
  true
)
on conflict (id) do update set body = excluded.body, is_pinned = excluded.is_pinned;

insert into callora.audit_events (
  id, organization_id, actor_user_id, action, entity_type, entity_id, request_id, metadata
) values (
  '10000000-0000-4000-8000-000000000c01',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000101',
  'call.note_created',
  'call_note',
  '10000000-0000-4000-8000-000000000b01',
  'seed-aster-001',
  '{"source":"development_seed"}'::jsonb
)
on conflict (id) do nothing;

select set_config('app.current_organization_id', '20000000-0000-4000-8000-000000000001', true);
select set_config('app.current_user_id', '20000000-0000-4000-8000-000000000101', true);

insert into callora.organizations (
  id, name, slug, status, plan, industry, support_email, primary_phone,
  time_zone, default_country_code, trial_ends_at
) values (
  '20000000-0000-4000-8000-000000000001',
  'Beacon Support Works',
  'beacon-support-works',
  'trial',
  'trial',
  'Customer support',
  'ops@beacon.test',
  '+919200000001',
  'Asia/Kolkata',
  '+91',
  clock_timestamp() + interval '14 days'
)
on conflict (id) do update set
  name = excluded.name,
  status = excluded.status,
  plan = excluded.plan,
  trial_ends_at = excluded.trial_ends_at;

insert into callora.users (
  id, organization_id, email, display_name, phone_number, status
) values (
  '20000000-0000-4000-8000-000000000101',
  '20000000-0000-4000-8000-000000000001',
  'owner@beacon.test',
  'Diya Patel',
  '+919200000101',
  'active'
)
on conflict (id) do update set
  display_name = excluded.display_name,
  phone_number = excluded.phone_number,
  status = excluded.status;

insert into callora.user_identities (
  id, organization_id, user_id, provider, issuer, subject, email_at_link_time
) values (
  '20000000-0000-4000-8000-000000000151',
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000101',
  'oidc',
  'https://identity.callora.test',
  'oidc-beacon-owner',
  'owner@beacon.test'
)
on conflict (organization_id, issuer, subject) do update set
  user_id = excluded.user_id,
  email_at_link_time = excluded.email_at_link_time;

insert into callora.roles (
  id, organization_id, name, description, system_key, is_editable
) values (
  '20000000-0000-4000-8000-000000000201',
  '20000000-0000-4000-8000-000000000001',
  'Owner',
  'Development tenant owner.',
  'owner',
  false
)
on conflict (id) do update set description = excluded.description;

insert into callora.organization_memberships (
  id, organization_id, user_id, status, invited_at, joined_at
) values (
  '20000000-0000-4000-8000-000000000301',
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000101',
  'active',
  statement_timestamp(),
  statement_timestamp()
)
on conflict (id) do update set
  status = excluded.status,
  joined_at = coalesce(callora.organization_memberships.joined_at, excluded.joined_at);

insert into callora.role_permissions (organization_id, role_id, permission_key)
select
  '20000000-0000-4000-8000-000000000001'::uuid,
  '20000000-0000-4000-8000-000000000201'::uuid,
  permission_key
from callora.permission_definitions
on conflict do nothing;

insert into callora.membership_roles (organization_id, membership_id, role_id) values (
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000301',
  '20000000-0000-4000-8000-000000000201'
)
on conflict do nothing;

insert into callora.teams (id, organization_id, name, description) values (
  '20000000-0000-4000-8000-000000000401',
  '20000000-0000-4000-8000-000000000001',
  'Support Desk',
  'Customer support and follow-up calls.'
)
on conflict (id) do update set description = excluded.description;

insert into callora.employees (
  id, organization_id, linked_user_id, team_id, employee_code, display_name,
  email, primary_phone, job_title, status, working_time_zone,
  working_week_days, working_day_starts_at, working_day_ends_at
) values (
  '20000000-0000-4000-8000-000000000501',
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000101',
  '20000000-0000-4000-8000-000000000401',
  'BCN-001',
  'Diya Patel',
  'owner@beacon.test',
  '+919200000101',
  'Support lead',
  'active',
  'Asia/Kolkata',
  array[1, 2, 3, 4, 5, 6]::smallint[],
  '09:30',
  '18:30'
)
on conflict (id) do update set
  team_id = excluded.team_id,
  display_name = excluded.display_name,
  status = excluded.status;

insert into callora.employee_devices (
  id, organization_id, employee_id, installation_id, platform, manufacturer,
  model, os_version, app_version, status, sync_state, call_log_permission,
  phone_state_permission, contacts_permission, notifications_permission,
  recording_files_permission, background_execution_permission, last_seen_at,
  registered_at, last_successful_sync_at
) values (
  '20000000-0000-4000-8000-000000000601',
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000501',
  'dev-beacon-samsung-01',
  'android',
  'Samsung',
  'Galaxy Dev',
  '15',
  '0.1.0',
  'connected',
  'idle',
  'granted',
  'granted',
  'granted',
  'granted',
  'denied',
  'granted',
  statement_timestamp(),
  statement_timestamp(),
  statement_timestamp()
)
on conflict (id) do update set
  app_version = excluded.app_version,
  status = excluded.status,
  sync_state = excluded.sync_state,
  last_seen_at = excluded.last_seen_at,
  last_successful_sync_at = excluded.last_successful_sync_at;

insert into callora.sim_cards (
  id, organization_id, device_id, slot_index, carrier_name, phone_number, subscription_id
) values (
  '20000000-0000-4000-8000-000000000701',
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000601',
  0,
  'Local Dev Carrier',
  '+919200000101',
  'beacon-sim-0'
)
on conflict (id) do update set phone_number = excluded.phone_number;

insert into callora.device_pairing_codes (
  id, organization_id, employee_id, code_hash, code_hint,
  created_by_user_id, expires_at
) values (
  '20000000-0000-4000-8000-000000000801',
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000501',
  digest('CALLORA-BEACON-DEV-PAIR', 'sha256'),
  'B101',
  '20000000-0000-4000-8000-000000000101',
  clock_timestamp() + interval '7 days'
)
on conflict (id) do update set
  expires_at = excluded.expires_at,
  revoked_at = null;

insert into callora.call_ingest_batches (
  id, organization_id, employee_id, device_id, batch_id, payload_sha256,
  item_count, processed_item_count, status, sent_at, completed_at
) values (
  '20000000-0000-4000-8000-000000000901',
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000501',
  '20000000-0000-4000-8000-000000000601',
  'beacon-batch-001',
  digest('beacon-batch-001', 'sha256'),
  1,
  1,
  'completed',
  clock_timestamp() - interval '25 minutes',
  statement_timestamp()
)
on conflict (id) do update set
  processed_item_count = excluded.processed_item_count,
  status = excluded.status,
  completed_at = excluded.completed_at;

insert into callora.call_logs (
  id, organization_id, employee_id, device_id, sim_card_id, ingest_batch_id,
  external_id, native_call_id, source, direction, disposition, phone_number,
  contact_name, started_at, ended_at, duration_seconds, ring_duration_seconds,
  is_within_working_hours, native_last_modified_at
) values (
  '20000000-0000-4000-8000-000000000a01',
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000501',
  '20000000-0000-4000-8000-000000000601',
  '20000000-0000-4000-8000-000000000701',
  '20000000-0000-4000-8000-000000000901',
  'beacon-call-001',
  'native-2001',
  'mobile_call_log',
  'incoming',
  'missed',
  '+919822220001',
  'Dev Customer B',
  clock_timestamp() - interval '25 minutes',
  clock_timestamp() - interval '24 minutes 42 seconds',
  0,
  18,
  true,
  clock_timestamp() - interval '24 minutes'
)
on conflict (id) do update set
  disposition = excluded.disposition,
  duration_seconds = excluded.duration_seconds,
  native_last_modified_at = excluded.native_last_modified_at;

insert into callora.call_notes (
  id, organization_id, call_log_id, author_user_id, body, is_pinned
) values (
  '20000000-0000-4000-8000-000000000b01',
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000a01',
  '20000000-0000-4000-8000-000000000101',
  'Missed call requires a callback.',
  true
)
on conflict (id) do update set body = excluded.body, is_pinned = excluded.is_pinned;

insert into callora.audit_events (
  id, organization_id, actor_user_id, action, entity_type, entity_id, request_id, metadata
) values (
  '20000000-0000-4000-8000-000000000c01',
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000101',
  'call.note_created',
  'call_note',
  '20000000-0000-4000-8000-000000000b01',
  'seed-beacon-001',
  '{"source":"development_seed"}'::jsonb
)
on conflict (id) do nothing;

commit;
