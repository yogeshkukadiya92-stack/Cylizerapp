create table callora.teams (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint teams_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete cascade,
  constraint teams_organization_id_key unique (organization_id, id),
  constraint teams_name_not_blank check (btrim(name) <> '')
);

create unique index teams_organization_name_key
  on callora.teams (organization_id, lower(name));
create index teams_active_idx
  on callora.teams (organization_id, name, id)
  where is_active = true;

create trigger teams_touch_updated_at
before update on callora.teams
for each row execute function callora.touch_updated_at();

create table callora.employees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  linked_user_id uuid,
  team_id uuid,
  manager_employee_id uuid,
  employee_code text,
  display_name text not null,
  email text,
  primary_phone text,
  job_title text,
  status text not null default 'invited',
  working_time_zone text,
  working_week_days smallint[],
  working_day_starts_at time,
  working_day_ends_at time,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint employees_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete cascade,
  constraint employees_linked_user_fk foreign key (organization_id, linked_user_id)
    references callora.users (organization_id, id) on delete set null (linked_user_id),
  constraint employees_team_fk foreign key (organization_id, team_id)
    references callora.teams (organization_id, id) on delete set null (team_id),
  constraint employees_manager_fk foreign key (organization_id, manager_employee_id)
    references callora.employees (organization_id, id) on delete set null (manager_employee_id),
  constraint employees_organization_id_key unique (organization_id, id),
  constraint employees_display_name_not_blank check (btrim(display_name) <> ''),
  constraint employees_status_valid
    check (status in ('invited', 'active', 'paused', 'deactivated')),
  constraint employees_working_hours_complete check (
    (working_time_zone is null and working_week_days is null
      and working_day_starts_at is null and working_day_ends_at is null)
    or
    (working_time_zone is not null and working_week_days is not null
      and working_day_starts_at is not null and working_day_ends_at is not null)
  ),
  constraint employees_working_week_days_valid check (
    working_week_days is null
    or (
      cardinality(working_week_days) between 1 and 7
      and working_week_days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]
    )
  ),
  constraint employees_working_day_order check (
    working_day_ends_at is null or working_day_ends_at > working_day_starts_at
  ),
  constraint employees_not_own_manager check (manager_employee_id is distinct from id)
);

create unique index employees_organization_employee_code_key
  on callora.employees (organization_id, lower(employee_code))
  where employee_code is not null;
create unique index employees_organization_email_key
  on callora.employees (organization_id, lower(email))
  where email is not null;
create unique index employees_linked_user_key
  on callora.employees (organization_id, linked_user_id)
  where linked_user_id is not null;
create index employees_team_status_idx
  on callora.employees (organization_id, team_id, status, display_name, id);
create index employees_manager_idx
  on callora.employees (organization_id, manager_employee_id, status)
  where manager_employee_id is not null;
create index employees_status_created_idx
  on callora.employees (organization_id, status, created_at desc, id desc);

create trigger employees_touch_updated_at
before update on callora.employees
for each row execute function callora.touch_updated_at();

create table callora.employee_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_id uuid not null,
  installation_id text not null,
  platform text not null,
  manufacturer text,
  model text,
  os_version text not null,
  app_version text not null,
  status text not null default 'pending',
  sync_state text not null default 'never_synced',
  call_log_permission text not null default 'unknown',
  phone_state_permission text not null default 'unknown',
  contacts_permission text not null default 'unknown',
  notifications_permission text not null default 'unknown',
  recording_files_permission text not null default 'unknown',
  background_execution_permission text not null default 'unknown',
  registered_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz,
  last_successful_sync_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint employee_devices_employee_fk foreign key (organization_id, employee_id)
    references callora.employees (organization_id, id) on delete cascade,
  constraint employee_devices_organization_id_key unique (organization_id, id),
  constraint employee_devices_installation_key unique (organization_id, installation_id),
  constraint employee_devices_installation_not_blank check (btrim(installation_id) <> ''),
  constraint employee_devices_platform_valid check (platform in ('android', 'ios')),
  constraint employee_devices_os_version_not_blank check (btrim(os_version) <> ''),
  constraint employee_devices_app_version_not_blank check (btrim(app_version) <> ''),
  constraint employee_devices_status_valid
    check (status in ('pending', 'connected', 'stale', 'revoked')),
  constraint employee_devices_sync_state_valid
    check (sync_state in ('never_synced', 'idle', 'syncing', 'degraded', 'failed')),
  constraint employee_devices_call_log_permission_valid
    check (call_log_permission in ('unknown', 'granted', 'denied', 'restricted')),
  constraint employee_devices_phone_state_permission_valid
    check (phone_state_permission in ('unknown', 'granted', 'denied', 'restricted')),
  constraint employee_devices_contacts_permission_valid
    check (contacts_permission in ('unknown', 'granted', 'denied', 'restricted')),
  constraint employee_devices_notifications_permission_valid
    check (notifications_permission in ('unknown', 'granted', 'denied', 'restricted')),
  constraint employee_devices_recording_files_permission_valid
    check (recording_files_permission in ('unknown', 'granted', 'denied', 'restricted')),
  constraint employee_devices_background_execution_permission_valid
    check (background_execution_permission in ('unknown', 'granted', 'denied', 'restricted')),
  constraint employee_devices_revocation_valid
    check ((status = 'revoked') = (revoked_at is not null)),
  constraint employee_devices_last_seen_valid
    check (last_seen_at is null or last_seen_at >= registered_at),
  constraint employee_devices_last_sync_valid
    check (last_successful_sync_at is null or last_successful_sync_at >= registered_at)
);

create index employee_devices_employee_status_idx
  on callora.employee_devices (organization_id, employee_id, status, id);
create index employee_devices_last_seen_idx
  on callora.employee_devices (organization_id, last_seen_at, id)
  where status in ('connected', 'stale');
create index employee_devices_sync_attention_idx
  on callora.employee_devices (organization_id, sync_state, last_seen_at, id)
  where sync_state in ('degraded', 'failed');

create trigger employee_devices_touch_updated_at
before update on callora.employee_devices
for each row execute function callora.touch_updated_at();

create table callora.sim_cards (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  device_id uuid not null,
  slot_index smallint not null,
  carrier_name text,
  phone_number text,
  subscription_id text,
  is_enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint sim_cards_device_fk foreign key (organization_id, device_id)
    references callora.employee_devices (organization_id, id) on delete cascade,
  constraint sim_cards_organization_id_key unique (organization_id, id),
  constraint sim_cards_device_id_key unique (organization_id, device_id, id),
  constraint sim_cards_device_slot_key unique (organization_id, device_id, slot_index),
  constraint sim_cards_slot_index_valid check (slot_index between 0 and 7)
);

create index sim_cards_device_enabled_idx
  on callora.sim_cards (organization_id, device_id, is_enabled, slot_index);

create trigger sim_cards_touch_updated_at
before update on callora.sim_cards
for each row execute function callora.touch_updated_at();

create table callora.device_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_id uuid not null,
  code_hash bytea not null,
  code_hint text not null,
  created_by_user_id uuid not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by_device_id uuid,
  revoked_at timestamptz,
  failed_attempt_count smallint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  constraint device_pairing_codes_employee_fk foreign key (organization_id, employee_id)
    references callora.employees (organization_id, id) on delete cascade,
  constraint device_pairing_codes_creator_fk foreign key (organization_id, created_by_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint device_pairing_codes_device_fk foreign key (organization_id, consumed_by_device_id)
    references callora.employee_devices (organization_id, id) on delete restrict,
  constraint device_pairing_codes_organization_id_key unique (organization_id, id),
  constraint device_pairing_codes_hash_key unique (code_hash),
  constraint device_pairing_codes_hash_length check (octet_length(code_hash) = 32),
  constraint device_pairing_codes_hint_length check (char_length(code_hint) between 2 and 8),
  constraint device_pairing_codes_expiry_valid check (expires_at > created_at),
  constraint device_pairing_codes_consumption_valid check (
    (consumed_at is null and consumed_by_device_id is null)
    or (consumed_at is not null and consumed_by_device_id is not null)
  ),
  constraint device_pairing_codes_consumed_at_valid
    check (consumed_at is null or (consumed_at >= created_at and consumed_at <= expires_at)),
  constraint device_pairing_codes_revoked_at_valid
    check (revoked_at is null or revoked_at >= created_at),
  constraint device_pairing_codes_attempt_count_valid
    check (failed_attempt_count between 0 and 20)
);

create index device_pairing_codes_active_idx
  on callora.device_pairing_codes (organization_id, employee_id, expires_at desc, id)
  where consumed_at is null and revoked_at is null;
create index device_pairing_codes_employee_idx
  on callora.device_pairing_codes (organization_id, employee_id, created_at desc, id);
create index device_pairing_codes_creator_idx
  on callora.device_pairing_codes (organization_id, created_by_user_id, created_at desc);
create index device_pairing_codes_consumed_device_idx
  on callora.device_pairing_codes (organization_id, consumed_by_device_id)
  where consumed_by_device_id is not null;
