-- Minimal, idempotent production bootstrap for the built-in administrator.
-- This intentionally creates no sample employees, devices, calls, leads, or reports.
begin;

select set_config('app.current_organization_id', '00000000-0000-4000-8000-000000000001', true);
select set_config('app.current_user_id', '00000000-0000-4000-8000-000000000101', true);

insert into callora.organizations (
  id, name, slug, status, plan, industry, support_email, primary_phone,
  time_zone, default_country_code
) values (
  '00000000-0000-4000-8000-000000000001',
  'Callora Workspace',
  'callora-workspace',
  'active',
  'growth',
  'Business services',
  'admin@callora.local',
  '+910000000000',
  'Asia/Kolkata',
  '+91'
)
on conflict (id) do nothing;

insert into callora.users (
  id, organization_id, email, display_name, status
) values (
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000001',
  'admin@callora.local',
  'Callora Administrator',
  'active'
)
on conflict (id) do update set status = excluded.status;

insert into callora.roles (
  id, organization_id, name, description, system_key, is_editable
) values (
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000001',
  'Owner',
  'Workspace owner with all available permissions.',
  'owner',
  false
)
on conflict (id) do update set description = excluded.description;

insert into callora.organization_memberships (
  id, organization_id, user_id, status, invited_at, joined_at
) values (
  '00000000-0000-4000-8000-000000000301',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000101',
  'active',
  statement_timestamp(),
  statement_timestamp()
)
on conflict (id) do update set
  status = excluded.status,
  joined_at = coalesce(callora.organization_memberships.joined_at, excluded.joined_at);

insert into callora.role_permissions (organization_id, role_id, permission_key)
select
  '00000000-0000-4000-8000-000000000001'::uuid,
  '00000000-0000-4000-8000-000000000201'::uuid,
  permission_key
from callora.permission_definitions
on conflict do nothing;

insert into callora.membership_roles (organization_id, membership_id, role_id) values (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000301',
  '00000000-0000-4000-8000-000000000201'
)
on conflict do nothing;

commit;
