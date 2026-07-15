create table callora.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  status text not null default 'trial',
  plan text not null default 'trial',
  industry text,
  logo_url text,
  support_email text,
  primary_phone text,
  billing_address jsonb not null default '{}'::jsonb,
  time_zone text not null default 'Asia/Kolkata',
  default_country_code text not null default '+91',
  working_week_days smallint[] not null default array[1, 2, 3, 4, 5, 6]::smallint[],
  working_day_starts_at time not null default '09:00',
  working_day_ends_at time not null default '18:00',
  recording_retention_days integer not null default 90,
  call_log_retention_days integer not null default 730,
  require_recording_consent boolean not null default true,
  mask_phone_numbers_for_restricted_users boolean not null default true,
  trial_ends_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint organizations_name_not_blank check (btrim(name) <> ''),
  constraint organizations_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint organizations_status_valid
    check (status in ('trial', 'active', 'past_due', 'suspended', 'closed')),
  constraint organizations_plan_valid
    check (plan in ('trial', 'starter', 'growth', 'business', 'enterprise')),
  constraint organizations_billing_address_object
    check (jsonb_typeof(billing_address) = 'object'),
  constraint organizations_country_code_format
    check (default_country_code ~ '^\+[1-9][0-9]{0,3}$'),
  constraint organizations_working_week_days_valid
    check (
      cardinality(working_week_days) between 1 and 7
      and working_week_days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]
    ),
  constraint organizations_working_day_order
    check (working_day_ends_at > working_day_starts_at),
  constraint organizations_recording_retention_valid
    check (recording_retention_days between 1 and 3650),
  constraint organizations_call_log_retention_valid
    check (call_log_retention_days between 1 and 3650)
);

create unique index organizations_slug_key on callora.organizations (lower(slug));
create index organizations_status_idx on callora.organizations (status)
  where status <> 'closed';

create trigger organizations_touch_updated_at
before update on callora.organizations
for each row execute function callora.touch_updated_at();

create table callora.users (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  email text not null,
  display_name text not null,
  phone_number text,
  avatar_url text,
  status text not null default 'invited',
  last_signed_in_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint users_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete cascade,
  constraint users_organization_id_key unique (organization_id, id),
  constraint users_email_not_blank check (btrim(email) <> ''),
  constraint users_email_basic_format check (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  constraint users_display_name_not_blank check (btrim(display_name) <> ''),
  constraint users_status_valid
    check (status in ('invited', 'active', 'suspended', 'deactivated'))
);

create unique index users_organization_email_key
  on callora.users (organization_id, lower(email));
create index users_organization_status_idx
  on callora.users (organization_id, status, created_at desc, id desc);

create trigger users_touch_updated_at
before update on callora.users
for each row execute function callora.touch_updated_at();

create table callora.roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  description text,
  system_key text,
  is_editable boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint roles_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete cascade,
  constraint roles_organization_id_key unique (organization_id, id),
  constraint roles_name_not_blank check (btrim(name) <> ''),
  constraint roles_system_key_valid
    check (system_key is null or system_key in ('owner', 'admin', 'manager', 'analyst', 'employee')),
  constraint roles_system_editability_valid
    check (system_key is null or is_editable = false)
);

create unique index roles_organization_name_key
  on callora.roles (organization_id, lower(name));
create unique index roles_organization_system_key
  on callora.roles (organization_id, system_key)
  where system_key is not null;

create trigger roles_touch_updated_at
before update on callora.roles
for each row execute function callora.touch_updated_at();

create table callora.permission_definitions (
  permission_key text primary key,
  description text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint permission_definitions_key_format
    check (permission_key ~ '^[a-z]+(\.[a-z]+)+$'),
  constraint permission_definitions_description_not_blank
    check (btrim(description) <> '')
);

insert into callora.permission_definitions (permission_key, description) values
  ('organization.read', 'View organization profile and settings.'),
  ('organization.manage', 'Update organization profile and settings.'),
  ('billing.read', 'View plan, usage, and invoices.'),
  ('billing.manage', 'Manage subscription and billing details.'),
  ('users.read', 'View organization users and memberships.'),
  ('users.manage', 'Invite and manage organization users.'),
  ('employees.read', 'View employees, teams, and devices.'),
  ('employees.manage', 'Manage employees and teams.'),
  ('devices.manage', 'Pair, configure, and revoke devices.'),
  ('calls.read', 'View call logs.'),
  ('calls.export', 'Export call logs.'),
  ('calls.annotate', 'Create notes and pin calls.'),
  ('recordings.listen', 'Listen to call recordings.'),
  ('recordings.manage', 'Manage recording lifecycle.'),
  ('leads.read', 'View leads.'),
  ('leads.manage', 'Create and update leads.'),
  ('leads.assign', 'Assign leads to employees.'),
  ('reports.read', 'View reports.'),
  ('reports.export', 'Export reports.'),
  ('integrations.read', 'View integrations.'),
  ('integrations.manage', 'Manage integrations.'),
  ('audit.read', 'View organization audit events.');

create table callora.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid not null,
  status text not null default 'invited',
  invited_by_user_id uuid,
  invited_at timestamptz not null default clock_timestamp(),
  joined_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint organization_memberships_user_fk foreign key (organization_id, user_id)
    references callora.users (organization_id, id) on delete cascade,
  constraint organization_memberships_inviter_fk foreign key (organization_id, invited_by_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint organization_memberships_organization_id_key unique (organization_id, id),
  constraint organization_memberships_user_key unique (organization_id, user_id),
  constraint organization_memberships_status_valid
    check (status in ('invited', 'active', 'suspended', 'deactivated')),
  constraint organization_memberships_joined_at_valid
    check (joined_at is null or joined_at >= invited_at)
);

create index organization_memberships_inviter_idx
  on callora.organization_memberships (organization_id, invited_by_user_id)
  where invited_by_user_id is not null;
create index organization_memberships_status_idx
  on callora.organization_memberships (organization_id, status, created_at desc, id desc);

create trigger organization_memberships_touch_updated_at
before update on callora.organization_memberships
for each row execute function callora.touch_updated_at();

create table callora.role_permissions (
  organization_id uuid not null,
  role_id uuid not null,
  permission_key text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, role_id, permission_key),
  constraint role_permissions_role_fk foreign key (organization_id, role_id)
    references callora.roles (organization_id, id) on delete cascade,
  constraint role_permissions_permission_fk foreign key (permission_key)
    references callora.permission_definitions (permission_key) on delete restrict
);

create index role_permissions_permission_idx
  on callora.role_permissions (permission_key, organization_id, role_id);

create table callora.membership_roles (
  organization_id uuid not null,
  membership_id uuid not null,
  role_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, membership_id, role_id),
  constraint membership_roles_membership_fk foreign key (organization_id, membership_id)
    references callora.organization_memberships (organization_id, id) on delete cascade,
  constraint membership_roles_role_fk foreign key (organization_id, role_id)
    references callora.roles (organization_id, id) on delete cascade
);

create index membership_roles_role_idx
  on callora.membership_roles (organization_id, role_id, membership_id);

create or replace function callora.current_user_has_permission(requested_permission text)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select exists (
    select 1
    from callora.organization_memberships as membership
    join callora.membership_roles as membership_role
      on membership_role.organization_id = membership.organization_id
     and membership_role.membership_id = membership.id
    join callora.role_permissions as role_permission
      on role_permission.organization_id = membership_role.organization_id
     and role_permission.role_id = membership_role.role_id
    where membership.organization_id = callora.current_organization_id()
      and membership.user_id = callora.current_user_id()
      and membership.status = 'active'
      and role_permission.permission_key = requested_permission
  )
$$;

revoke execute on function callora.current_user_has_permission(text) from public;
