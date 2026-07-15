begin;

create table callora.saved_report_views (
  organization_id uuid not null,
  id uuid not null,
  owner_user_id uuid not null,
  name text not null check (char_length(name) between 1 and 120),
  report_kind text not null check (report_kind in ('call_summary','employee_performance','client_activity','never_attended','client_not_pickup','lead_performance','lead_status','lead_not_contacted','status_change')),
  filters jsonb not null default '{}'::jsonb check (jsonb_typeof(filters) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint saved_report_views_owner_fkey foreign key (organization_id, owner_user_id) references callora.users (organization_id, id),
  constraint saved_report_views_owner_name_key unique (organization_id, owner_user_id, name)
);

create table callora.report_schedules (
  organization_id uuid not null,
  id uuid not null,
  saved_view_id uuid not null,
  created_by_user_id uuid not null,
  name text not null check (char_length(name) between 1 and 120),
  cadence text not null check (cadence in ('daily','weekly')),
  week_day smallint check (week_day between 1 and 7),
  local_time time not null,
  time_zone text not null,
  format text not null check (format in ('csv','xlsx','pdf')),
  recipients jsonb not null check (jsonb_typeof(recipients) = 'array' and jsonb_array_length(recipients) between 1 and 50),
  status text not null default 'active' check (status in ('active','paused')),
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  last_period_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint report_schedules_view_fkey foreign key (organization_id, saved_view_id) references callora.saved_report_views (organization_id, id),
  constraint report_schedules_creator_fkey foreign key (organization_id, created_by_user_id) references callora.users (organization_id, id),
  constraint report_schedules_weekly_day check ((cadence = 'weekly' and week_day is not null) or (cadence = 'daily' and week_day is null)),
  constraint report_schedules_period_once_key unique (organization_id, id, last_period_key)
);

create table callora.notification_preferences (
  organization_id uuid not null,
  user_id uuid not null,
  event_key text not null check (event_key in ('missed_call','overdue_follow_up','device_offline','import_completed','export_ready')),
  email_enabled boolean not null default true,
  in_app_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id, event_key),
  constraint notification_preferences_user_fkey foreign key (organization_id, user_id) references callora.users (organization_id, id)
);

create table callora.report_export_jobs (
  organization_id uuid not null,
  id uuid not null,
  requested_by_user_id uuid not null,
  saved_view_id uuid,
  schedule_id uuid,
  report_kind text not null,
  format text not null check (format in ('csv','xlsx','pdf')),
  parameters jsonb not null default '{}'::jsonb check (jsonb_typeof(parameters) = 'object'),
  status text not null default 'queued' check (status in ('queued','processing','ready','failed','expired')),
  attempts smallint not null default 0 check (attempts between 0 and 5),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  object_key text,
  download_token_hash bytea,
  download_expires_at timestamptz,
  failure_message text,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  primary key (organization_id, id),
  constraint report_export_jobs_requester_fkey foreign key (organization_id, requested_by_user_id) references callora.users (organization_id, id),
  constraint report_export_jobs_view_fkey foreign key (organization_id, saved_view_id) references callora.saved_report_views (organization_id, id),
  constraint report_export_jobs_schedule_fkey foreign key (organization_id, schedule_id) references callora.report_schedules (organization_id, id),
  constraint report_export_jobs_download_ready check ((status = 'ready' and object_key is not null and download_token_hash is not null and download_expires_at is not null) or status <> 'ready')
);

create index saved_report_views_owner_idx on callora.saved_report_views (organization_id, owner_user_id, updated_at desc);
create index report_schedules_view_idx on callora.report_schedules (organization_id, saved_view_id);
create index report_schedules_creator_idx on callora.report_schedules (organization_id, created_by_user_id);
create index report_schedules_due_idx on callora.report_schedules (organization_id, next_run_at) where status = 'active';
create index notification_preferences_user_idx on callora.notification_preferences (organization_id, user_id);
create index report_export_jobs_requester_idx on callora.report_export_jobs (organization_id, requested_by_user_id, requested_at desc);
create index report_export_jobs_view_idx on callora.report_export_jobs (organization_id, saved_view_id);
create index report_export_jobs_schedule_idx on callora.report_export_jobs (organization_id, schedule_id);
create index report_export_jobs_queue_idx on callora.report_export_jobs (available_at, requested_at) where status = 'queued';

create or replace function callora.claim_report_export_job(p_worker_id text, p_lease_seconds integer default 300)
returns setof callora.report_export_jobs language sql security definer set search_path = callora, pg_temp as $$
  update callora.report_export_jobs set status = 'processing', attempts = attempts + 1,
    lease_owner = p_worker_id, lease_expires_at = now() + make_interval(secs => p_lease_seconds), started_at = coalesce(started_at, now())
  where (organization_id, id) = (
    select organization_id, id from callora.report_export_jobs
    where status = 'queued' and available_at <= now() and attempts < 5
    order by available_at, requested_at limit 1 for update skip locked
  ) returning *;
$$;

alter table callora.saved_report_views enable row level security;
alter table callora.saved_report_views force row level security;
create policy saved_report_views_tenant on callora.saved_report_views for all using (organization_id = callora.current_organization_id()) with check (organization_id = callora.current_organization_id());
alter table callora.report_schedules enable row level security;
alter table callora.report_schedules force row level security;
create policy report_schedules_tenant on callora.report_schedules for all using (organization_id = callora.current_organization_id()) with check (organization_id = callora.current_organization_id());
alter table callora.notification_preferences enable row level security;
alter table callora.notification_preferences force row level security;
create policy notification_preferences_tenant on callora.notification_preferences for all using (organization_id = callora.current_organization_id()) with check (organization_id = callora.current_organization_id());
alter table callora.report_export_jobs enable row level security;
alter table callora.report_export_jobs force row level security;
create policy report_export_jobs_tenant on callora.report_export_jobs for all using (organization_id = callora.current_organization_id()) with check (organization_id = callora.current_organization_id());

revoke all on callora.saved_report_views, callora.report_schedules, callora.notification_preferences, callora.report_export_jobs from public;

revoke all on function callora.claim_report_export_job(text, integer) from public;
grant execute on function callora.claim_report_export_job(text, integer) to callora_worker;
grant select, insert, update, delete on callora.saved_report_views, callora.report_schedules to callora_api;
grant select, insert, update on callora.notification_preferences, callora.report_export_jobs to callora_api;
grant select, update on callora.report_export_jobs, callora.report_schedules to callora_worker;

commit;
