-- Phase 4B: resumable lead imports, deterministic assignment rules, and
-- reporting indexes. Import staging never stores a plaintext phone number.

create table callora.lead_assignment_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  name text not null,
  priority integer not null,
  active boolean not null default true,
  conditions jsonb not null default '{}'::jsonb,
  strategy text not null,
  round_robin_cursor bigint not null default 0,
  version bigint not null default 1,
  created_by_user_id uuid not null,
  updated_by_user_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint lead_assignment_rules_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete cascade,
  constraint lead_assignment_rules_team_fk foreign key (organization_id, team_id)
    references callora.teams (organization_id, id) on delete restrict,
  constraint lead_assignment_rules_created_by_fk foreign key (organization_id, created_by_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint lead_assignment_rules_updated_by_fk foreign key (organization_id, updated_by_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint lead_assignment_rules_organization_id_key unique (organization_id, id),
  constraint lead_assignment_rules_organization_team_id_key unique (organization_id, team_id, id),
  constraint lead_assignment_rules_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint lead_assignment_rules_priority_valid check (priority between 1 and 10000),
  constraint lead_assignment_rules_conditions_object check (jsonb_typeof(conditions) = 'object'),
  constraint lead_assignment_rules_strategy_valid check (strategy in ('fixed_owner', 'round_robin')),
  constraint lead_assignment_rules_cursor_valid check (round_robin_cursor >= 0),
  constraint lead_assignment_rules_version_valid check (version > 0),
  constraint lead_assignment_rules_updated_at_valid check (updated_at >= created_at)
);

create index lead_assignment_rules_match_idx
  on callora.lead_assignment_rules (organization_id, team_id, active, priority, id);
create index lead_assignment_rules_created_by_idx
  on callora.lead_assignment_rules (organization_id, created_by_user_id, created_at desc, id desc);
create index lead_assignment_rules_updated_by_idx
  on callora.lead_assignment_rules (organization_id, updated_by_user_id, updated_at desc, id desc);

create or replace function callora.require_next_lead_assignment_rule_version()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if new.version is distinct from old.version + 1 then
    raise exception 'lead assignment rule updates must advance version by exactly one'
      using errcode = '40001';
  end if;
  return new;
end
$$;

revoke execute on function callora.require_next_lead_assignment_rule_version() from public;

create trigger lead_assignment_rules_require_next_version
before update on callora.lead_assignment_rules
for each row execute function callora.require_next_lead_assignment_rule_version();

create trigger lead_assignment_rules_touch_updated_at
before update on callora.lead_assignment_rules
for each row execute function callora.touch_updated_at();

create table callora.lead_assignment_rule_employees (
  organization_id uuid not null,
  team_id uuid not null,
  rule_id uuid not null,
  employee_id uuid not null,
  position integer not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, rule_id, employee_id),
  constraint lead_assignment_rule_employees_rule_fk foreign key (organization_id, team_id, rule_id)
    references callora.lead_assignment_rules (organization_id, team_id, id) on delete cascade,
  constraint lead_assignment_rule_employees_employee_fk foreign key (organization_id, team_id, employee_id)
    references callora.employees (organization_id, team_id, id) on delete restrict,
  constraint lead_assignment_rule_employees_position_valid check (position between 0 and 99),
  constraint lead_assignment_rule_employees_rule_position_key
    unique (organization_id, rule_id, position)
);

create index lead_assignment_rule_employees_employee_idx
  on callora.lead_assignment_rule_employees (organization_id, team_id, employee_id, rule_id);
create index lead_assignment_rule_employees_rule_idx
  on callora.lead_assignment_rule_employees (organization_id, team_id, rule_id, position);

create table callora.lead_import_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  request_id text not null,
  request_fingerprint text not null,
  file_name text not null,
  status text not null default 'preview_ready',
  total_rows integer not null,
  valid_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  error_rows integer not null default 0,
  imported_rows integer not null default 0,
  processed_rows integer not null default 0,
  created_by_user_id uuid not null,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint lead_import_jobs_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete cascade,
  constraint lead_import_jobs_created_by_fk foreign key (organization_id, created_by_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint lead_import_jobs_organization_id_key unique (organization_id, id),
  constraint lead_import_jobs_request_key unique (organization_id, request_id),
  constraint lead_import_jobs_request_id_length check (char_length(request_id) between 8 and 100),
  constraint lead_import_jobs_request_fingerprint_format check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint lead_import_jobs_file_name_length check (char_length(btrim(file_name)) between 1 and 255),
  constraint lead_import_jobs_status_valid check (
    status in ('preview_ready', 'processing', 'completed', 'interrupted', 'failed')
  ),
  constraint lead_import_jobs_total_rows_valid check (total_rows between 1 and 1000),
  constraint lead_import_jobs_counts_valid check (
    valid_rows >= 0 and duplicate_rows >= 0 and error_rows >= 0
    and imported_rows >= 0 and processed_rows >= 0
    and valid_rows + duplicate_rows + error_rows = total_rows
    and imported_rows <= valid_rows and processed_rows <= total_rows
  ),
  constraint lead_import_jobs_completion_valid check (
    (status = 'completed' and completed_at is not null and processed_rows = total_rows)
    or (status <> 'completed' and completed_at is null)
  ),
  constraint lead_import_jobs_last_error_length check (
    last_error is null or char_length(btrim(last_error)) between 1 and 1000
  ),
  constraint lead_import_jobs_updated_at_valid check (updated_at >= created_at)
);

create index lead_import_jobs_created_keyset_idx
  on callora.lead_import_jobs (organization_id, created_at desc, id desc);
create index lead_import_jobs_creator_idx
  on callora.lead_import_jobs (organization_id, created_by_user_id, created_at desc, id desc);
create index lead_import_jobs_resume_idx
  on callora.lead_import_jobs (organization_id, status, updated_at, id)
  where status in ('processing', 'interrupted', 'failed');

create trigger lead_import_jobs_touch_updated_at
before update on callora.lead_import_jobs
for each row execute function callora.touch_updated_at();

create table callora.lead_import_rows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  job_id uuid not null,
  row_number integer not null,
  decision text not null,
  team_id uuid,
  status_id uuid,
  proposed_assigned_employee_id uuid,
  assignment_rule_id uuid,
  assignment_rule_version bigint,
  duplicate_row_number integer,
  duplicate_lead_id uuid,
  imported_lead_id uuid,
  first_name text,
  last_name text,
  company_name text,
  email text,
  source text not null,
  status_name text,
  assigned_employee_code text,
  tag_names jsonb not null default '[]'::jsonb,
  custom_fields jsonb not null default '{}'::jsonb,
  phone_encryption_version smallint,
  phone_key_version integer,
  phone_blind_index_key_version integer,
  phone_number_ciphertext bytea,
  phone_number_nonce bytea,
  phone_number_blind_index bytea,
  phone_number_last_four text,
  phone_encrypted_at timestamptz,
  alternate_phone_encryption_version smallint,
  alternate_phone_key_version integer,
  alternate_phone_blind_index_key_version integer,
  alternate_phone_number_ciphertext bytea,
  alternate_phone_number_nonce bytea,
  alternate_phone_number_blind_index bytea,
  alternate_phone_number_last_four text,
  alternate_phone_encrypted_at timestamptz,
  issues jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint lead_import_rows_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete cascade,
  constraint lead_import_rows_job_fk foreign key (organization_id, job_id)
    references callora.lead_import_jobs (organization_id, id) on delete cascade,
  constraint lead_import_rows_team_fk foreign key (organization_id, team_id)
    references callora.teams (organization_id, id) on delete restrict,
  constraint lead_import_rows_status_fk foreign key (organization_id, status_id)
    references callora.lead_statuses (organization_id, id) on delete restrict,
  constraint lead_import_rows_assignee_fk foreign key (
    organization_id, team_id, proposed_assigned_employee_id
  ) references callora.employees (organization_id, team_id, id) on delete restrict,
  constraint lead_import_rows_rule_fk foreign key (organization_id, team_id, assignment_rule_id)
    references callora.lead_assignment_rules (organization_id, team_id, id) on delete restrict,
  constraint lead_import_rows_rule_version_valid check (
    (assignment_rule_id is null and assignment_rule_version is null)
    or (assignment_rule_id is not null and assignment_rule_version > 0)
  ),
  constraint lead_import_rows_duplicate_lead_fk foreign key (organization_id, duplicate_lead_id)
    references callora.leads (organization_id, id) on delete restrict,
  constraint lead_import_rows_imported_lead_fk foreign key (organization_id, imported_lead_id)
    references callora.leads (organization_id, id) on delete restrict,
  constraint lead_import_rows_organization_id_key unique (organization_id, id),
  constraint lead_import_rows_job_row_key unique (organization_id, job_id, row_number),
  constraint lead_import_rows_row_number_valid check (row_number between 1 and 1000),
  constraint lead_import_rows_duplicate_row_valid check (
    duplicate_row_number is null or duplicate_row_number between 1 and 1000
  ),
  constraint lead_import_rows_decision_valid check (decision in ('valid', 'duplicate', 'invalid', 'imported')),
  constraint lead_import_rows_first_name_length check (
    first_name is null or char_length(btrim(first_name)) between 1 and 200
  ),
  constraint lead_import_rows_source_valid check (
    source in (
      'manual', 'csv_import', 'website', 'facebook', 'instagram',
      'google_ads', 'india_mart', 'api', 'integration', 'unknown'
    )
  ),
  constraint lead_import_rows_phone_envelope_complete check (
    num_nonnulls(
      phone_encryption_version, phone_key_version, phone_blind_index_key_version,
      phone_number_ciphertext, phone_number_nonce, phone_number_blind_index,
      phone_number_last_four, phone_encrypted_at
    ) = 0
    or (
      num_nonnulls(
        phone_encryption_version, phone_key_version, phone_blind_index_key_version,
        phone_number_ciphertext, phone_number_nonce, phone_number_blind_index,
        phone_number_last_four, phone_encrypted_at
      ) = 8
      and phone_encryption_version = 2 and phone_key_version > 0
      and phone_blind_index_key_version > 0
      and octet_length(phone_number_ciphertext) >= 17
      and octet_length(phone_number_nonce) = 12
      and octet_length(phone_number_blind_index) = 32
      and phone_number_last_four ~ '^[0-9]{4}$'
    )
  ),
  constraint lead_import_rows_alternate_phone_envelope_complete check (
    num_nonnulls(
      alternate_phone_encryption_version, alternate_phone_key_version,
      alternate_phone_blind_index_key_version, alternate_phone_number_ciphertext,
      alternate_phone_number_nonce, alternate_phone_number_blind_index,
      alternate_phone_number_last_four, alternate_phone_encrypted_at
    ) = 0
    or (
      num_nonnulls(
        alternate_phone_encryption_version, alternate_phone_key_version,
        alternate_phone_blind_index_key_version, alternate_phone_number_ciphertext,
        alternate_phone_number_nonce, alternate_phone_number_blind_index,
        alternate_phone_number_last_four, alternate_phone_encrypted_at
      ) = 8
      and alternate_phone_encryption_version = 2
      and alternate_phone_key_version > 0
      and alternate_phone_blind_index_key_version > 0
      and octet_length(alternate_phone_number_ciphertext) >= 17
      and octet_length(alternate_phone_number_nonce) = 12
      and octet_length(alternate_phone_number_blind_index) = 32
      and alternate_phone_number_last_four ~ '^[0-9]{4}$'
    )
  ),
  constraint lead_import_rows_tag_names_array check (
    jsonb_typeof(tag_names) = 'array' and jsonb_array_length(tag_names) <= 100
  ),
  constraint lead_import_rows_custom_fields_object check (jsonb_typeof(custom_fields) = 'object'),
  constraint lead_import_rows_issues_array check (jsonb_typeof(issues) = 'array'),
  constraint lead_import_rows_resolution_valid check (
    (decision = 'valid' and first_name is not null and team_id is not null and status_id is not null
      and phone_number_ciphertext is not null
      and duplicate_lead_id is null and imported_lead_id is null)
    or (decision = 'duplicate' and first_name is not null and phone_number_ciphertext is not null
      and num_nonnulls(duplicate_row_number, duplicate_lead_id) = 1 and imported_lead_id is null)
    or (decision = 'invalid' and jsonb_array_length(issues) > 0 and imported_lead_id is null
      and phone_number_ciphertext is null)
    or (decision = 'imported' and first_name is not null and phone_number_ciphertext is not null
      and imported_lead_id is not null)
  ),
  constraint lead_import_rows_updated_at_valid check (updated_at >= created_at)
);

create index lead_import_rows_job_decision_idx
  on callora.lead_import_rows (organization_id, job_id, decision, row_number);
create index lead_import_rows_team_status_idx
  on callora.lead_import_rows (organization_id, team_id, status_id, row_number)
  where team_id is not null and status_id is not null;
create index lead_import_rows_status_idx
  on callora.lead_import_rows (organization_id, status_id, row_number)
  where status_id is not null;
create index lead_import_rows_assignee_idx
  on callora.lead_import_rows (organization_id, team_id, proposed_assigned_employee_id, row_number)
  where proposed_assigned_employee_id is not null;
create index lead_import_rows_rule_idx
  on callora.lead_import_rows (organization_id, team_id, assignment_rule_id, row_number)
  where assignment_rule_id is not null;
create index lead_import_rows_duplicate_idx
  on callora.lead_import_rows (organization_id, duplicate_lead_id, job_id)
  where duplicate_lead_id is not null;
create index lead_import_rows_imported_idx
  on callora.lead_import_rows (organization_id, imported_lead_id, job_id)
  where imported_lead_id is not null;
create unique index lead_import_rows_phone_nonce_key
  on callora.lead_import_rows (organization_id, phone_key_version, phone_number_nonce);
create unique index lead_import_rows_alternate_phone_nonce_key
  on callora.lead_import_rows (
    organization_id, alternate_phone_key_version, alternate_phone_number_nonce
  ) where alternate_phone_number_nonce is not null;

create trigger lead_import_rows_touch_updated_at
before update on callora.lead_import_rows
for each row execute function callora.touch_updated_at();

-- Cohort and activity reports are bounded by tenant and time.
create index leads_created_report_idx
  on callora.leads (organization_id, created_at, id)
  where archived_at is null;
create index lead_activities_report_idx
  on callora.lead_activities (organization_id, occurred_at, kind, id);

alter table callora.lead_assignment_rules enable row level security;
alter table callora.lead_assignment_rules force row level security;
create policy lead_assignment_rules_tenant_isolation on callora.lead_assignment_rules
using (organization_id = callora.current_organization_id())
with check (organization_id = callora.current_organization_id());

alter table callora.lead_assignment_rule_employees enable row level security;
alter table callora.lead_assignment_rule_employees force row level security;
create policy lead_assignment_rule_employees_tenant_isolation on callora.lead_assignment_rule_employees
using (organization_id = callora.current_organization_id())
with check (organization_id = callora.current_organization_id());

alter table callora.lead_import_jobs enable row level security;
alter table callora.lead_import_jobs force row level security;
create policy lead_import_jobs_tenant_isolation on callora.lead_import_jobs
using (organization_id = callora.current_organization_id())
with check (organization_id = callora.current_organization_id());

alter table callora.lead_import_rows enable row level security;
alter table callora.lead_import_rows force row level security;
create policy lead_import_rows_tenant_isolation on callora.lead_import_rows
using (organization_id = callora.current_organization_id())
with check (organization_id = callora.current_organization_id());

revoke all on callora.lead_assignment_rules from public;
revoke all on callora.lead_assignment_rule_employees from public;
revoke all on callora.lead_import_jobs from public;
revoke all on callora.lead_import_rows from public;
