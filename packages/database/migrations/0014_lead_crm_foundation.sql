-- Phase 4A: tenant- and team-scoped lead CRM foundation.
-- Import jobs and assignment-rule execution intentionally follow in Phase 4B.

-- A lead and its assignee must remain in the same team. The extra referenced
-- key makes that invariant enforceable with one composite foreign key.
alter table callora.employees
  add constraint employees_organization_team_id_key
  unique (organization_id, team_id, id);

create table callora.membership_team_scopes (
  organization_id uuid not null,
  membership_id uuid not null,
  team_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, membership_id, team_id),
  constraint membership_team_scopes_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete cascade,
  constraint membership_team_scopes_membership_fk foreign key (organization_id, membership_id)
    references callora.organization_memberships (organization_id, id) on delete cascade,
  constraint membership_team_scopes_team_fk foreign key (organization_id, team_id)
    references callora.teams (organization_id, id) on delete cascade
);

create index membership_team_scopes_team_membership_idx
  on callora.membership_team_scopes (organization_id, team_id, membership_id);

create table callora.lead_statuses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  color text not null,
  position integer not null,
  is_initial boolean not null default false,
  is_won boolean not null default false,
  is_lost boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint lead_statuses_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete cascade,
  constraint lead_statuses_organization_id_key unique (organization_id, id),
  constraint lead_statuses_name_not_blank check (char_length(btrim(name)) between 1 and 100),
  constraint lead_statuses_color_format check (color ~ '^#[0-9A-Fa-f]{6}$'),
  constraint lead_statuses_position_valid check (position >= 0),
  constraint lead_statuses_terminal_exclusive check (not (is_won and is_lost)),
  constraint lead_statuses_initial_not_terminal check (not is_initial or not (is_won or is_lost))
);

create unique index lead_statuses_organization_name_key
  on callora.lead_statuses (organization_id, lower(name));
create unique index lead_statuses_active_position_key
  on callora.lead_statuses (organization_id, position)
  where is_active;
create unique index lead_statuses_single_initial_key
  on callora.lead_statuses (organization_id)
  where is_initial and is_active;

create trigger lead_statuses_touch_updated_at
before update on callora.lead_statuses
for each row execute function callora.touch_updated_at();

create table callora.leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  status_id uuid not null,
  assigned_employee_id uuid,
  created_by_user_id uuid,
  updated_by_user_id uuid,
  first_name text not null,
  last_name text,
  company_name text,
  email text,
  source text not null default 'manual',
  source_reference text,
  temperature text,
  phone_encryption_version smallint not null default 2,
  phone_key_version integer not null,
  phone_blind_index_key_version integer not null,
  phone_number_ciphertext bytea not null,
  phone_number_nonce bytea not null,
  phone_number_blind_index bytea not null,
  phone_number_last_four text not null,
  phone_encrypted_at timestamptz not null,
  alternate_phone_encryption_version smallint,
  alternate_phone_key_version integer,
  alternate_phone_blind_index_key_version integer,
  alternate_phone_number_ciphertext bytea,
  alternate_phone_number_nonce bytea,
  alternate_phone_number_blind_index bytea,
  alternate_phone_number_last_four text,
  alternate_phone_encrypted_at timestamptz,
  tag_ids jsonb not null default '[]'::jsonb,
  custom_fields jsonb not null default '{}'::jsonb,
  last_contacted_at timestamptz,
  next_follow_up_at timestamptz,
  converted_at timestamptz,
  lost_at timestamptz,
  archived_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint leads_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete cascade,
  constraint leads_team_fk foreign key (organization_id, team_id)
    references callora.teams (organization_id, id) on delete restrict,
  constraint leads_status_fk foreign key (organization_id, status_id)
    references callora.lead_statuses (organization_id, id) on delete restrict,
  constraint leads_assigned_employee_fk foreign key (
    organization_id, team_id, assigned_employee_id
  ) references callora.employees (organization_id, team_id, id) on delete restrict,
  constraint leads_created_by_user_fk foreign key (organization_id, created_by_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint leads_updated_by_user_fk foreign key (organization_id, updated_by_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint leads_organization_id_key unique (organization_id, id),
  constraint leads_organization_team_id_key unique (organization_id, team_id, id),
  constraint leads_first_name_length check (char_length(btrim(first_name)) between 1 and 200),
  constraint leads_last_name_length check (
    last_name is null or char_length(btrim(last_name)) between 1 and 200
  ),
  constraint leads_company_name_length check (
    company_name is null or char_length(btrim(company_name)) between 1 and 300
  ),
  constraint leads_email_format check (
    email is null
    or (char_length(email) between 3 and 320 and email = btrim(email) and position('@' in email) > 1)
  ),
  constraint leads_source_valid check (
    source in (
      'manual', 'csv_import', 'website', 'facebook', 'instagram',
      'google_ads', 'india_mart', 'api', 'integration', 'unknown'
    )
  ),
  constraint leads_source_reference_not_blank check (
    source_reference is null or btrim(source_reference) <> ''
  ),
  constraint leads_temperature_valid check (
    temperature is null or temperature in ('cold', 'warm', 'hot')
  ),
  constraint leads_phone_encryption_version_valid check (phone_encryption_version = 2),
  constraint leads_phone_key_version_valid check (phone_key_version > 0),
  constraint leads_phone_blind_index_key_version_valid check (phone_blind_index_key_version > 0),
  constraint leads_phone_ciphertext_valid check (octet_length(phone_number_ciphertext) >= 17),
  constraint leads_phone_nonce_valid check (octet_length(phone_number_nonce) = 12),
  constraint leads_phone_blind_index_valid check (octet_length(phone_number_blind_index) = 32),
  constraint leads_phone_last_four_format check (phone_number_last_four ~ '^[0-9]{4}$'),
  constraint leads_alternate_phone_envelope_complete check (
    num_nonnulls(
      alternate_phone_encryption_version,
      alternate_phone_key_version,
      alternate_phone_blind_index_key_version,
      alternate_phone_number_ciphertext,
      alternate_phone_number_nonce,
      alternate_phone_number_blind_index,
      alternate_phone_number_last_four,
      alternate_phone_encrypted_at
    ) = 0
    or (
      num_nonnulls(
        alternate_phone_encryption_version,
        alternate_phone_key_version,
        alternate_phone_blind_index_key_version,
        alternate_phone_number_ciphertext,
        alternate_phone_number_nonce,
        alternate_phone_number_blind_index,
        alternate_phone_number_last_four,
        alternate_phone_encrypted_at
      ) = 8
      and alternate_phone_encryption_version = 2
      and alternate_phone_key_version > 0
      and alternate_phone_blind_index_key_version > 0
      and octet_length(alternate_phone_number_ciphertext) >= 17
      and octet_length(alternate_phone_number_nonce) = 12
      and octet_length(alternate_phone_number_blind_index) = 32
      and alternate_phone_number_last_four ~ '^[0-9]{4}$'
      and alternate_phone_encrypted_at is not null
    )
  ),
  constraint leads_tag_ids_array check (
    jsonb_typeof(tag_ids) = 'array' and jsonb_array_length(tag_ids) <= 100
  ),
  constraint leads_custom_fields_object check (jsonb_typeof(custom_fields) = 'object'),
  constraint leads_terminal_state_exclusive check (converted_at is null or lost_at is null),
  constraint leads_version_valid check (version > 0),
  constraint leads_updated_at_valid check (updated_at >= created_at)
);

create unique index leads_phone_nonce_key
  on callora.leads (organization_id, phone_key_version, phone_number_nonce);
create unique index leads_alternate_phone_nonce_key
  on callora.leads (
    organization_id, alternate_phone_key_version, alternate_phone_number_nonce
  )
  where alternate_phone_number_nonce is not null;
create unique index leads_source_reference_key
  on callora.leads (organization_id, source, source_reference)
  where source_reference is not null;
create index leads_phone_blind_lookup_idx
  on callora.leads (
    organization_id, phone_blind_index_key_version, phone_number_blind_index, id
  );
create index leads_alternate_phone_blind_lookup_idx
  on callora.leads (
    organization_id, alternate_phone_blind_index_key_version,
    alternate_phone_number_blind_index, id
  )
  where alternate_phone_number_blind_index is not null;
create index leads_team_status_created_keyset_idx
  on callora.leads (organization_id, team_id, status_id, created_at desc, id desc)
  where archived_at is null;
create index leads_assignee_status_follow_up_idx
  on callora.leads (
    organization_id, team_id, assigned_employee_id, status_id, next_follow_up_at, id
  )
  where assigned_employee_id is not null and archived_at is null;
create index leads_status_created_keyset_idx
  on callora.leads (organization_id, status_id, created_at desc, id desc);
create index leads_created_by_created_idx
  on callora.leads (organization_id, created_by_user_id, created_at desc, id desc)
  where created_by_user_id is not null;
create index leads_updated_by_updated_idx
  on callora.leads (organization_id, updated_by_user_id, updated_at desc, id desc)
  where updated_by_user_id is not null;
create index leads_not_contacted_queue_idx
  on callora.leads (organization_id, team_id, created_at, id)
  where last_contacted_at is null and archived_at is null;
create index leads_due_follow_up_queue_idx
  on callora.leads (organization_id, team_id, next_follow_up_at, id)
  where next_follow_up_at is not null and archived_at is null;
create index leads_email_lookup_idx
  on callora.leads (organization_id, lower(email), id)
  where email is not null and archived_at is null;

create or replace function callora.require_next_lead_version()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if new.version is distinct from old.version + 1 then
    raise exception 'lead updates must advance version by exactly one'
      using errcode = '40001';
  end if;
  return new;
end
$$;

revoke execute on function callora.require_next_lead_version() from public;

create trigger leads_require_next_version
before update on callora.leads
for each row execute function callora.require_next_lead_version();

create trigger leads_touch_updated_at
before update on callora.leads
for each row execute function callora.touch_updated_at();

create table callora.lead_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id uuid not null,
  author_user_id uuid not null,
  body text not null,
  is_pinned boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint lead_notes_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete cascade,
  constraint lead_notes_lead_fk foreign key (organization_id, lead_id)
    references callora.leads (organization_id, id) on delete cascade,
  constraint lead_notes_author_fk foreign key (organization_id, author_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint lead_notes_organization_id_key unique (organization_id, id),
  constraint lead_notes_body_length check (char_length(btrim(body)) between 1 and 10000),
  constraint lead_notes_updated_at_valid check (updated_at >= created_at)
);

create index lead_notes_lead_created_idx
  on callora.lead_notes (organization_id, lead_id, created_at desc, id desc);
create index lead_notes_author_created_idx
  on callora.lead_notes (organization_id, author_user_id, created_at desc, id desc);
create index lead_notes_pinned_idx
  on callora.lead_notes (organization_id, lead_id, created_at desc, id desc)
  where is_pinned;

create trigger lead_notes_touch_updated_at
before update on callora.lead_notes
for each row execute function callora.touch_updated_at();

create table callora.lead_follow_ups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  team_id uuid not null,
  lead_id uuid not null,
  assigned_employee_id uuid not null,
  created_by_user_id uuid not null,
  completed_by_user_id uuid,
  cancelled_by_user_id uuid,
  title text not null,
  notes text,
  due_at timestamptz not null,
  reminder_at timestamptz,
  priority text not null default 'normal',
  status text not null default 'pending',
  completed_at timestamptz,
  cancelled_at timestamptz,
  version bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint lead_follow_ups_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete cascade,
  constraint lead_follow_ups_lead_fk foreign key (organization_id, team_id, lead_id)
    references callora.leads (organization_id, team_id, id) on delete cascade,
  constraint lead_follow_ups_assigned_employee_fk foreign key (
    organization_id, team_id, assigned_employee_id
  ) references callora.employees (organization_id, team_id, id) on delete restrict,
  constraint lead_follow_ups_created_by_user_fk foreign key (organization_id, created_by_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint lead_follow_ups_completed_by_user_fk foreign key (organization_id, completed_by_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint lead_follow_ups_cancelled_by_user_fk foreign key (organization_id, cancelled_by_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint lead_follow_ups_organization_id_key unique (organization_id, id),
  constraint lead_follow_ups_title_length check (char_length(btrim(title)) between 1 and 300),
  constraint lead_follow_ups_notes_length check (
    notes is null or char_length(btrim(notes)) between 1 and 10000
  ),
  constraint lead_follow_ups_priority_valid check (
    priority in ('low', 'normal', 'high', 'urgent')
  ),
  constraint lead_follow_ups_status_valid check (
    status in ('pending', 'completed', 'cancelled')
  ),
  constraint lead_follow_ups_reminder_order check (
    reminder_at is null or reminder_at <= due_at
  ),
  constraint lead_follow_ups_state_complete check (
    (
      status = 'pending'
      and completed_at is null and completed_by_user_id is null
      and cancelled_at is null and cancelled_by_user_id is null
    )
    or (
      status = 'completed'
      and completed_at is not null and completed_by_user_id is not null
      and cancelled_at is null and cancelled_by_user_id is null
    )
    or (
      status = 'cancelled'
      and cancelled_at is not null and cancelled_by_user_id is not null
      and completed_at is null and completed_by_user_id is null
    )
  ),
  constraint lead_follow_ups_completion_order check (
    completed_at is null or completed_at >= created_at
  ),
  constraint lead_follow_ups_cancellation_order check (
    cancelled_at is null or cancelled_at >= created_at
  ),
  constraint lead_follow_ups_version_valid check (version > 0),
  constraint lead_follow_ups_updated_at_valid check (updated_at >= created_at)
);

create index lead_follow_ups_lead_created_idx
  on callora.lead_follow_ups (organization_id, team_id, lead_id, created_at desc, id desc);
create index lead_follow_ups_lead_lookup_idx
  on callora.lead_follow_ups (organization_id, lead_id, created_at desc, id desc);
create index lead_follow_ups_assignee_due_idx
  on callora.lead_follow_ups (
    organization_id, team_id, assigned_employee_id, status, due_at, id
  );
create index lead_follow_ups_pending_due_idx
  on callora.lead_follow_ups (organization_id, due_at, id)
  where status = 'pending';
create index lead_follow_ups_created_by_idx
  on callora.lead_follow_ups (organization_id, created_by_user_id, created_at desc, id desc);
create index lead_follow_ups_completed_by_idx
  on callora.lead_follow_ups (organization_id, completed_by_user_id, completed_at desc, id desc)
  where completed_by_user_id is not null;
create index lead_follow_ups_cancelled_by_idx
  on callora.lead_follow_ups (organization_id, cancelled_by_user_id, cancelled_at desc, id desc)
  where cancelled_by_user_id is not null;

create trigger lead_follow_ups_touch_updated_at
before update on callora.lead_follow_ups
for each row execute function callora.touch_updated_at();

create or replace function callora.require_next_lead_follow_up_version()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if new.version is distinct from old.version + 1 then
    raise exception 'lead follow-up updates must advance version by exactly one'
      using errcode = '40001';
  end if;
  return new;
end
$$;

revoke execute on function callora.require_next_lead_follow_up_version() from public;

create trigger lead_follow_ups_require_next_version
before update on callora.lead_follow_ups
for each row execute function callora.require_next_lead_follow_up_version();

create table callora.lead_activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  lead_id uuid not null,
  actor_user_id uuid,
  actor_employee_id uuid,
  call_log_id uuid,
  kind text not null,
  summary text not null,
  old_values jsonb not null default '{}'::jsonb,
  new_values jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  constraint lead_activities_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete cascade,
  constraint lead_activities_lead_fk foreign key (organization_id, lead_id)
    references callora.leads (organization_id, id) on delete cascade,
  constraint lead_activities_actor_user_fk foreign key (organization_id, actor_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint lead_activities_actor_employee_fk foreign key (organization_id, actor_employee_id)
    references callora.employees (organization_id, id) on delete restrict,
  constraint lead_activities_call_log_fk foreign key (organization_id, call_log_id)
    references callora.call_logs (organization_id, id) on delete restrict,
  constraint lead_activities_organization_id_key unique (organization_id, id),
  constraint lead_activities_kind_valid check (
    kind in (
      'created', 'updated', 'assigned', 'unassigned', 'status_changed',
      'custom_fields_changed', 'tag_added', 'tag_removed', 'note_added',
      'call_linked', 'call_unlinked', 'follow_up_created',
      'follow_up_completed', 'follow_up_cancelled'
    )
  ),
  constraint lead_activities_summary_length check (char_length(btrim(summary)) between 1 and 1000),
  constraint lead_activities_old_values_object check (jsonb_typeof(old_values) = 'object'),
  constraint lead_activities_new_values_object check (jsonb_typeof(new_values) = 'object'),
  constraint lead_activities_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint lead_activities_change_has_delta check (
    kind not in ('assigned', 'status_changed', 'custom_fields_changed')
    or old_values is distinct from new_values
  )
);

create index lead_activities_lead_timeline_idx
  on callora.lead_activities (organization_id, lead_id, occurred_at desc, id desc);
create index lead_activities_actor_user_idx
  on callora.lead_activities (organization_id, actor_user_id, occurred_at desc, id desc)
  where actor_user_id is not null;
create index lead_activities_actor_employee_idx
  on callora.lead_activities (organization_id, actor_employee_id, occurred_at desc, id desc)
  where actor_employee_id is not null;
create index lead_activities_call_log_idx
  on callora.lead_activities (organization_id, call_log_id, occurred_at desc, id desc)
  where call_log_id is not null;

create or replace function callora.reject_lead_activity_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  raise exception 'lead activities are append-only' using errcode = '55000';
end
$$;

revoke execute on function callora.reject_lead_activity_mutation() from public;

create trigger lead_activities_append_only
before update or delete on callora.lead_activities
for each row execute function callora.reject_lead_activity_mutation();

create table callora.call_lead_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  call_log_id uuid not null,
  lead_id uuid not null,
  link_source text not null,
  match_confidence numeric(5, 4),
  linked_by_user_id uuid,
  linked_by_employee_id uuid,
  correction_reason text,
  linked_at timestamptz not null default clock_timestamp(),
  unlinked_at timestamptz,
  unlinked_by_user_id uuid,
  unlinked_by_employee_id uuid,
  unlink_reason text,
  constraint call_lead_links_organization_fk foreign key (organization_id)
    references callora.organizations (id) on delete cascade,
  constraint call_lead_links_call_log_fk foreign key (organization_id, call_log_id)
    references callora.call_logs (organization_id, id) on delete cascade,
  constraint call_lead_links_lead_fk foreign key (organization_id, lead_id)
    references callora.leads (organization_id, id) on delete cascade,
  constraint call_lead_links_linked_by_user_fk foreign key (organization_id, linked_by_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint call_lead_links_linked_by_employee_fk foreign key (organization_id, linked_by_employee_id)
    references callora.employees (organization_id, id) on delete restrict,
  constraint call_lead_links_unlinked_by_user_fk foreign key (organization_id, unlinked_by_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint call_lead_links_unlinked_by_employee_fk foreign key (organization_id, unlinked_by_employee_id)
    references callora.employees (organization_id, id) on delete restrict,
  constraint call_lead_links_organization_id_key unique (organization_id, id),
  constraint call_lead_links_source_valid check (link_source in ('automatic', 'manual')),
  constraint call_lead_links_confidence_valid check (
    match_confidence is null or (match_confidence >= 0 and match_confidence <= 1)
  ),
  constraint call_lead_links_link_evidence check (
    (
      link_source = 'automatic'
      and match_confidence is not null
      and (correction_reason is null or btrim(correction_reason) <> '')
    )
    or (
      link_source = 'manual'
      and (linked_by_user_id is not null or linked_by_employee_id is not null)
      and correction_reason is not null
      and btrim(correction_reason) <> ''
    )
  ),
  constraint call_lead_links_unlink_complete check (
    (
      unlinked_at is null
      and unlinked_by_user_id is null
      and unlinked_by_employee_id is null
      and unlink_reason is null
    )
    or (
      unlinked_at is not null
      and unlinked_at >= linked_at
      and (unlinked_by_user_id is not null or unlinked_by_employee_id is not null)
      and unlink_reason is not null
      and btrim(unlink_reason) <> ''
    )
  )
);

create unique index call_lead_links_one_active_call_key
  on callora.call_lead_links (organization_id, call_log_id)
  where unlinked_at is null;
create index call_lead_links_call_history_idx
  on callora.call_lead_links (organization_id, call_log_id, linked_at desc, id desc);
create index call_lead_links_lead_history_idx
  on callora.call_lead_links (organization_id, lead_id, linked_at desc, id desc);
create index call_lead_links_linked_user_idx
  on callora.call_lead_links (organization_id, linked_by_user_id, linked_at desc, id desc)
  where linked_by_user_id is not null;
create index call_lead_links_linked_employee_idx
  on callora.call_lead_links (organization_id, linked_by_employee_id, linked_at desc, id desc)
  where linked_by_employee_id is not null;
create index call_lead_links_unlinked_user_idx
  on callora.call_lead_links (organization_id, unlinked_by_user_id, unlinked_at desc, id desc)
  where unlinked_by_user_id is not null;
create index call_lead_links_unlinked_employee_idx
  on callora.call_lead_links (organization_id, unlinked_by_employee_id, unlinked_at desc, id desc)
  where unlinked_by_employee_id is not null;

create or replace function callora.guard_call_lead_link_history()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'call-to-lead link history cannot be deleted' using errcode = '55000';
  end if;

  if old.unlinked_at is not null then
    raise exception 'unlinked call-to-lead history is immutable' using errcode = '55000';
  end if;

  if new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.call_log_id is distinct from old.call_log_id
     or new.lead_id is distinct from old.lead_id
     or new.link_source is distinct from old.link_source
     or new.match_confidence is distinct from old.match_confidence
     or new.linked_by_user_id is distinct from old.linked_by_user_id
     or new.linked_by_employee_id is distinct from old.linked_by_employee_id
     or new.correction_reason is distinct from old.correction_reason
     or new.linked_at is distinct from old.linked_at
     or new.unlinked_at is null then
    raise exception 'call-to-lead links permit only a one-way audited unlink'
      using errcode = '55000';
  end if;

  return new;
end
$$;

revoke execute on function callora.guard_call_lead_link_history() from public;

create trigger call_lead_links_guard_history
before update or delete on callora.call_lead_links
for each row execute function callora.guard_call_lead_link_history();

alter table callora.membership_team_scopes enable row level security;
alter table callora.membership_team_scopes force row level security;
create policy membership_team_scopes_tenant_isolation on callora.membership_team_scopes
using (organization_id = callora.current_organization_id())
with check (organization_id = callora.current_organization_id());

alter table callora.lead_statuses enable row level security;
alter table callora.lead_statuses force row level security;
create policy lead_statuses_tenant_isolation on callora.lead_statuses
using (organization_id = callora.current_organization_id())
with check (organization_id = callora.current_organization_id());

alter table callora.leads enable row level security;
alter table callora.leads force row level security;
create policy leads_tenant_isolation on callora.leads
using (organization_id = callora.current_organization_id())
with check (organization_id = callora.current_organization_id());

alter table callora.lead_notes enable row level security;
alter table callora.lead_notes force row level security;
create policy lead_notes_tenant_isolation on callora.lead_notes
using (organization_id = callora.current_organization_id())
with check (organization_id = callora.current_organization_id());

alter table callora.lead_follow_ups enable row level security;
alter table callora.lead_follow_ups force row level security;
create policy lead_follow_ups_tenant_isolation on callora.lead_follow_ups
using (organization_id = callora.current_organization_id())
with check (organization_id = callora.current_organization_id());

alter table callora.lead_activities enable row level security;
alter table callora.lead_activities force row level security;
create policy lead_activities_tenant_isolation on callora.lead_activities
using (organization_id = callora.current_organization_id())
with check (organization_id = callora.current_organization_id());

alter table callora.call_lead_links enable row level security;
alter table callora.call_lead_links force row level security;
create policy call_lead_links_tenant_isolation on callora.call_lead_links
using (organization_id = callora.current_organization_id())
with check (organization_id = callora.current_organization_id());

revoke all on callora.membership_team_scopes from public;
revoke all on callora.lead_statuses from public;
revoke all on callora.leads from public;
revoke all on callora.lead_notes from public;
revoke all on callora.lead_follow_ups from public;
revoke all on callora.lead_activities from public;
revoke all on callora.call_lead_links from public;
