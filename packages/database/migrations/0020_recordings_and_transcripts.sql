begin;

create table callora.call_recordings (
  organization_id uuid not null, id uuid not null, call_log_id uuid not null, source text not null,
  status text not null default 'uploading', storage_key text, file_name text not null, mime_type text not null,
  size_bytes bigint not null, checksum_sha256 text not null, retention_until timestamptz not null,
  legal_hold boolean not null default false, uploaded_at timestamptz, deleted_at timestamptz,
  transcription_status text not null default 'not_requested', created_at timestamptz not null default statement_timestamp(), updated_at timestamptz not null default statement_timestamp(),
  primary key (organization_id,id), foreign key (organization_id,call_log_id) references callora.call_logs(organization_id,id),
  constraint call_recordings_source_check check(source in ('device_folder','voip_provider','manual_upload')),
  constraint call_recordings_status_check check(status in ('uploading','available','failed','deleted')),
  constraint call_recordings_mime_check check(mime_type in ('audio/mpeg','audio/mp4','audio/wav','audio/ogg')),
  constraint call_recordings_size_check check(size_bytes>0 and size_bytes<=524288000),
  constraint call_recordings_checksum_check check(checksum_sha256~'^[a-f0-9]{64}$'), unique(organization_id,checksum_sha256)
);
create index call_recordings_call_idx on callora.call_recordings(organization_id,call_log_id);
create index call_recordings_retention_idx on callora.call_recordings(organization_id,retention_until) where deleted_at is null and not legal_hold;

create table callora.recording_uploads (
  organization_id uuid not null, id uuid not null, recording_id uuid not null, device_id uuid, expires_at timestamptz not null,
  completed_at timestamptz, created_at timestamptz not null default statement_timestamp(), primary key(organization_id,id),
  foreign key(organization_id,recording_id) references callora.call_recordings(organization_id,id),
  foreign key(organization_id,device_id) references callora.employee_devices(organization_id,id)
);
create index recording_uploads_recording_idx on callora.recording_uploads(organization_id,recording_id);
create index recording_uploads_device_idx on callora.recording_uploads(organization_id,device_id) where device_id is not null;

create table callora.recording_upload_parts (
  organization_id uuid not null, upload_id uuid not null, part_number integer not null, size_bytes integer not null,
  checksum_sha256 text not null, object_etag text, created_at timestamptz not null default statement_timestamp(),
  primary key(organization_id,upload_id,part_number), foreign key(organization_id,upload_id) references callora.recording_uploads(organization_id,id),
  constraint recording_part_number_check check(part_number between 1 and 10000), constraint recording_part_size_check check(size_bytes between 1 and 5242880)
);

create table callora.recording_transcripts (
  organization_id uuid not null, recording_id uuid not null, language text not null, redacted_text text not null,
  segments jsonb not null default '[]'::jsonb, provider_reference text, created_at timestamptz not null default statement_timestamp(), updated_at timestamptz not null default statement_timestamp(),
  primary key(organization_id,recording_id), foreign key(organization_id,recording_id) references callora.call_recordings(organization_id,id) on delete cascade
);

create table callora.recording_access_audit (
  organization_id uuid not null, id uuid not null, recording_id uuid not null, actor_user_id uuid, action text not null,
  occurred_at timestamptz not null default statement_timestamp(), metadata jsonb not null default '{}'::jsonb, primary key(organization_id,id),
  foreign key(organization_id,recording_id) references callora.call_recordings(organization_id,id),
  constraint recording_access_action_check check(action in ('upload','play','transcribe','delete','legal_hold'))
);
create index recording_access_recording_idx on callora.recording_access_audit(organization_id,recording_id,occurred_at desc);

alter table callora.call_recordings enable row level security; alter table callora.call_recordings force row level security;
alter table callora.recording_uploads enable row level security; alter table callora.recording_uploads force row level security;
alter table callora.recording_upload_parts enable row level security; alter table callora.recording_upload_parts force row level security;
alter table callora.recording_transcripts enable row level security; alter table callora.recording_transcripts force row level security;
alter table callora.recording_access_audit enable row level security; alter table callora.recording_access_audit force row level security;
create policy call_recordings_tenant on callora.call_recordings using(organization_id=callora.current_organization_id()) with check(organization_id=callora.current_organization_id());
create policy recording_uploads_tenant on callora.recording_uploads using(organization_id=callora.current_organization_id()) with check(organization_id=callora.current_organization_id());
create policy recording_upload_parts_tenant on callora.recording_upload_parts using(organization_id=callora.current_organization_id()) with check(organization_id=callora.current_organization_id());
create policy recording_transcripts_tenant on callora.recording_transcripts using(organization_id=callora.current_organization_id()) with check(organization_id=callora.current_organization_id());
create policy recording_access_audit_tenant on callora.recording_access_audit using(organization_id=callora.current_organization_id()) with check(organization_id=callora.current_organization_id());

commit;
