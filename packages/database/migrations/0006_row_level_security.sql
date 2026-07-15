-- Every table containing tenant data uses the same transaction-local context.
-- The application must set app.current_organization_id with set_config(..., true)
-- after authenticating and authorizing the organization membership.

alter table callora.organizations enable row level security;
alter table callora.organizations force row level security;
create policy organizations_tenant_isolation on callora.organizations
  for all
  using (id = (select callora.current_organization_id()))
  with check (id = (select callora.current_organization_id()));

alter table callora.users enable row level security;
alter table callora.users force row level security;
create policy users_tenant_isolation on callora.users
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

alter table callora.roles enable row level security;
alter table callora.roles force row level security;
create policy roles_tenant_isolation on callora.roles
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

alter table callora.organization_memberships enable row level security;
alter table callora.organization_memberships force row level security;
create policy organization_memberships_tenant_isolation on callora.organization_memberships
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

alter table callora.role_permissions enable row level security;
alter table callora.role_permissions force row level security;
create policy role_permissions_tenant_isolation on callora.role_permissions
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

alter table callora.membership_roles enable row level security;
alter table callora.membership_roles force row level security;
create policy membership_roles_tenant_isolation on callora.membership_roles
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

alter table callora.teams enable row level security;
alter table callora.teams force row level security;
create policy teams_tenant_isolation on callora.teams
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

alter table callora.employees enable row level security;
alter table callora.employees force row level security;
create policy employees_tenant_isolation on callora.employees
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

alter table callora.employee_devices enable row level security;
alter table callora.employee_devices force row level security;
create policy employee_devices_tenant_isolation on callora.employee_devices
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

alter table callora.sim_cards enable row level security;
alter table callora.sim_cards force row level security;
create policy sim_cards_tenant_isolation on callora.sim_cards
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

alter table callora.device_pairing_codes enable row level security;
alter table callora.device_pairing_codes force row level security;
create policy device_pairing_codes_tenant_isolation on callora.device_pairing_codes
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

alter table callora.call_ingest_batches enable row level security;
alter table callora.call_ingest_batches force row level security;
create policy call_ingest_batches_tenant_isolation on callora.call_ingest_batches
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

alter table callora.call_logs enable row level security;
alter table callora.call_logs force row level security;
create policy call_logs_tenant_isolation on callora.call_logs
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

alter table callora.call_notes enable row level security;
alter table callora.call_notes force row level security;
create policy call_notes_tenant_isolation on callora.call_notes
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

alter table callora.audit_events enable row level security;
alter table callora.audit_events force row level security;
create policy audit_events_tenant_select on callora.audit_events
  for select
  using (organization_id = (select callora.current_organization_id()));
create policy audit_events_tenant_insert on callora.audit_events
  for insert
  with check (organization_id = (select callora.current_organization_id()));
