begin;

create table callora.report_download_redemptions (
  organization_id uuid not null,
  id uuid not null,
  report_export_job_id uuid not null,
  redeemed_by_user_id uuid not null,
  token_fingerprint bytea not null check (octet_length(token_fingerprint) = 32),
  redeemed_at timestamptz not null,
  primary key (organization_id, id),
  constraint report_download_redemptions_job_fkey foreign key (organization_id, report_export_job_id) references callora.report_export_jobs (organization_id, id),
  constraint report_download_redemptions_user_fkey foreign key (organization_id, redeemed_by_user_id) references callora.users (organization_id, id),
  constraint report_download_redemptions_job_once_key unique (organization_id, report_export_job_id)
);

create table callora.notification_deliveries (
  organization_id uuid not null,
  id uuid not null,
  user_id uuid not null,
  event_key text not null check (event_key in ('missed_call','overdue_follow_up','device_offline','import_completed','export_ready')),
  channel text not null check (channel in ('email','in_app')),
  deduplication_key text not null check (char_length(deduplication_key) between 1 and 240),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  status text not null default 'queued' check (status in ('queued','processing','delivered','suppressed','failed')),
  attempt_count smallint not null default 0 check (attempt_count between 0 and 5),
  available_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  delivered_at timestamptz,
  suppressed_reason text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  constraint notification_deliveries_user_fkey foreign key (organization_id, user_id) references callora.users (organization_id, id),
  constraint notification_deliveries_dedupe_key unique (organization_id, user_id, channel, deduplication_key),
  constraint notification_deliveries_lock_complete check ((locked_by is null) = (locked_at is null)),
  constraint notification_deliveries_terminal_state check ((status = 'delivered') = (delivered_at is not null))
);

create table callora.in_app_notifications (
  organization_id uuid not null,
  id uuid not null,
  delivery_id uuid not null,
  user_id uuid not null,
  event_key text not null,
  title text not null check (char_length(title) between 1 and 160),
  body text not null check (char_length(body) between 1 and 1000),
  action_url text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  primary key (organization_id, id),
  constraint in_app_notifications_delivery_fkey foreign key (organization_id, delivery_id) references callora.notification_deliveries (organization_id, id),
  constraint in_app_notifications_user_fkey foreign key (organization_id, user_id) references callora.users (organization_id, id),
  constraint in_app_notifications_delivery_key unique (organization_id, delivery_id)
);

create index report_download_redemptions_job_idx on callora.report_download_redemptions (organization_id, report_export_job_id);
create index report_download_redemptions_user_idx on callora.report_download_redemptions (organization_id, redeemed_by_user_id, redeemed_at desc);
create index notification_deliveries_user_idx on callora.notification_deliveries (organization_id, user_id, created_at desc);
create index notification_deliveries_ready_idx on callora.notification_deliveries (organization_id, available_at, id) where status = 'queued';
create index in_app_notifications_delivery_idx on callora.in_app_notifications (organization_id, delivery_id);
create index in_app_notifications_user_unread_idx on callora.in_app_notifications (organization_id, user_id, created_at desc) where read_at is null;

create or replace function callora.enqueue_due_report_schedules(p_at timestamptz, p_limit integer default 50)
returns table (organization_id uuid, job_id uuid, schedule_id uuid) language plpgsql security definer set search_path = callora, pg_temp as $$
begin
  if p_limit < 1 or p_limit > 100 then raise exception 'p_limit must be between 1 and 100'; end if;
  return query
  with due as (
    select s.organization_id, s.id, s.saved_view_id, s.created_by_user_id, s.format,
      to_char(p_at at time zone s.time_zone, case when s.cadence='daily' then 'YYYY-MM-DD' else 'IYYY-IW' end) as period_key
    from callora.report_schedules s where s.status='active' and s.next_run_at <= p_at
    order by s.next_run_at, s.id for update skip locked limit p_limit
  ), created as (
    insert into callora.report_export_jobs (organization_id,id,requested_by_user_id,saved_view_id,schedule_id,report_kind,format,parameters,status,requested_at)
    select d.organization_id, gen_random_uuid(), d.created_by_user_id, d.saved_view_id, d.id, v.report_kind, d.format,
      jsonb_build_object('schedulePeriodKey',d.period_key), 'queued', p_at from due d join callora.saved_report_views v on v.organization_id=d.organization_id and v.id=d.saved_view_id
    on conflict do nothing returning report_export_jobs.organization_id, report_export_jobs.id, report_export_jobs.schedule_id
  )
  update callora.report_schedules s set last_run_at=p_at, last_period_key=d.period_key,
    next_run_at=s.next_run_at + case when s.cadence='daily' then interval '1 day' else interval '7 days' end, updated_at=p_at
  from due d where s.organization_id=d.organization_id and s.id=d.id
  returning s.organization_id, (select c.id from created c where c.organization_id=s.organization_id and c.schedule_id=s.id), s.id;
end $$;

create unique index report_export_jobs_schedule_period_key on callora.report_export_jobs (organization_id, schedule_id, ((parameters ->> 'schedulePeriodKey'))) where schedule_id is not null;

alter table callora.report_download_redemptions enable row level security;
alter table callora.report_download_redemptions force row level security;
create policy report_download_redemptions_tenant on callora.report_download_redemptions for all using (organization_id=callora.current_organization_id()) with check (organization_id=callora.current_organization_id());
alter table callora.notification_deliveries enable row level security;
alter table callora.notification_deliveries force row level security;
create policy notification_deliveries_tenant on callora.notification_deliveries for all using (organization_id=callora.current_organization_id()) with check (organization_id=callora.current_organization_id());
alter table callora.in_app_notifications enable row level security;
alter table callora.in_app_notifications force row level security;
create policy in_app_notifications_tenant on callora.in_app_notifications for all using (organization_id=callora.current_organization_id()) with check (organization_id=callora.current_organization_id());

revoke all on callora.report_download_redemptions, callora.notification_deliveries, callora.in_app_notifications from public;
revoke all on function callora.enqueue_due_report_schedules(timestamptz, integer) from public;
grant execute on function callora.enqueue_due_report_schedules(timestamptz, integer) to callora_worker;
grant select, insert on callora.report_download_redemptions to callora_api;
grant select, update on callora.in_app_notifications to callora_api;
grant select, insert, update on callora.notification_deliveries, callora.in_app_notifications to callora_worker;

commit;
