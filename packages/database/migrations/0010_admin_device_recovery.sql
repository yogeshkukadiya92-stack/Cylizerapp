-- Phase 3D: administrator recovery for one stranded device. The immutable
-- request ledger, device transition, credential/consent revocation, audit row,
-- and outbox event commit in one tenant-scoped transaction.

create table callora.device_admin_revocations (
  organization_id uuid not null,
  request_id uuid not null,
  device_id uuid not null,
  employee_id uuid not null,
  actor_user_id uuid not null,
  request_fingerprint bytea not null,
  reason text not null,
  revoked_credential_count integer not null,
  consent_withdrawn boolean not null,
  audit_event_id uuid not null,
  outbox_event_id uuid not null,
  response_body jsonb not null,
  completed_at timestamptz not null,
  created_at timestamptz not null,
  constraint device_admin_revocations_pk primary key (organization_id, request_id),
  constraint device_admin_revocations_device_fk
    foreign key (organization_id, device_id)
    references callora.employee_devices (organization_id, id) on delete restrict,
  constraint device_admin_revocations_employee_fk
    foreign key (organization_id, employee_id)
    references callora.employees (organization_id, id) on delete restrict,
  constraint device_admin_revocations_actor_fk
    foreign key (organization_id, actor_user_id)
    references callora.users (organization_id, id) on delete restrict,
  constraint device_admin_revocations_audit_fk
    foreign key (organization_id, audit_event_id)
    references callora.audit_events (organization_id, id) on delete restrict,
  constraint device_admin_revocations_outbox_fk
    foreign key (organization_id, outbox_event_id)
    references callora.outbox_events (organization_id, id) on delete restrict,
  constraint device_admin_revocations_device_request_key
    unique (organization_id, device_id, request_id),
  constraint device_admin_revocations_audit_key
    unique (organization_id, audit_event_id),
  constraint device_admin_revocations_outbox_key
    unique (organization_id, outbox_event_id),
  constraint device_admin_revocations_fingerprint_length
    check (octet_length(request_fingerprint) = 32),
  constraint device_admin_revocations_reason_length
    check (char_length(reason) between 8 and 500 and reason = btrim(reason)),
  constraint device_admin_revocations_reason_single_line
    check (reason !~ '[[:cntrl:]]'),
  constraint device_admin_revocations_credential_count_valid
    check (revoked_credential_count >= 0),
  constraint device_admin_revocations_response_object
    check (jsonb_typeof(response_body) = 'object'),
  constraint device_admin_revocations_completion_order
    check (completed_at >= created_at)
);

create index device_admin_revocations_employee_idx
  on callora.device_admin_revocations
    (organization_id, employee_id, completed_at desc, request_id);
create index device_admin_revocations_actor_idx
  on callora.device_admin_revocations
    (organization_id, actor_user_id, completed_at desc, request_id);

create or replace function callora.reject_device_admin_revocation_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  raise exception 'administrator device revocations are append-only'
    using errcode = '55000';
end
$$;

revoke execute on function callora.reject_device_admin_revocation_mutation()
  from public;

create trigger device_admin_revocations_append_only
before update or delete on callora.device_admin_revocations
for each row execute function callora.reject_device_admin_revocation_mutation();

alter table callora.device_admin_revocations enable row level security;
alter table callora.device_admin_revocations force row level security;
create policy device_admin_revocations_tenant_isolation on callora.device_admin_revocations
  for all
  using (organization_id = (select callora.current_organization_id()))
  with check (organization_id = (select callora.current_organization_id()));

revoke all on table callora.device_admin_revocations from public;

create or replace function callora.admin_revoke_device(
  p_request_id uuid,
  p_organization_id uuid,
  p_device_id uuid,
  p_actor_user_id uuid,
  p_audit_event_id uuid,
  p_outbox_event_id uuid,
  p_request_fingerprint bytea,
  p_reason text,
  p_revoked_at timestamptz
)
returns table (
  response_body jsonb,
  replayed boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_existing callora.device_admin_revocations%rowtype;
  v_device callora.employee_devices%rowtype;
  v_revoked_credential_count integer;
  v_withdrawn_count integer;
  v_consent_withdrawn boolean;
  v_metadata jsonb;
  v_response jsonb;
begin
  if callora.current_organization_id() is distinct from p_organization_id
     or callora.current_user_id() is distinct from p_actor_user_id then
    raise exception 'administrator recovery context does not match actor'
      using errcode = '42501';
  end if;
  if not callora.current_user_has_permission('devices.manage') then
    raise exception 'devices.manage is required for administrator recovery'
      using errcode = '42501';
  end if;
  if octet_length(p_request_fingerprint) <> 32 then
    raise exception 'invalid administrator recovery fingerprint'
      using errcode = '22023';
  end if;
  if p_reason is null
     or char_length(p_reason) not between 8 and 500
     or p_reason <> btrim(p_reason)
     or p_reason ~ '[[:cntrl:]]' then
    raise exception 'invalid administrator recovery reason'
      using errcode = '22023';
  end if;

  select * into v_existing
  from callora.device_admin_revocations as recovery
  where recovery.organization_id = p_organization_id
    and recovery.request_id = p_request_id
  for update;
  if found then
    if v_existing.device_id is distinct from p_device_id
       or v_existing.request_fingerprint is distinct from p_request_fingerprint
       or v_existing.reason is distinct from p_reason then
      raise exception 'request id was reused with conflicting recovery metadata'
        using errcode = '23505';
    end if;
    return query select v_existing.response_body, true;
    return;
  end if;

  select * into v_device
  from callora.employee_devices as device
  where device.organization_id = p_organization_id
    and device.id = p_device_id
  for update;
  if not found then
    raise exception 'device does not exist in administrator tenant'
      using errcode = '23503';
  end if;

  -- Recheck after the device lock so concurrent exact retries observe the
  -- immutable request committed by the lock holder instead of a false conflict.
  select * into v_existing
  from callora.device_admin_revocations as recovery
  where recovery.organization_id = p_organization_id
    and recovery.request_id = p_request_id
  for update;
  if found then
    if v_existing.device_id is distinct from p_device_id
       or v_existing.request_fingerprint is distinct from p_request_fingerprint
       or v_existing.reason is distinct from p_reason then
      raise exception 'request id was reused with conflicting recovery metadata'
        using errcode = '23505';
    end if;
    return query select v_existing.response_body, true;
    return;
  end if;

  if v_device.status = 'revoked' or v_device.revoked_at is not null then
    raise exception 'device is already revoked' using errcode = '55000';
  end if;

  perform credential.id
  from callora.device_credentials as credential
  where credential.organization_id = p_organization_id
    and credential.device_id = p_device_id
  order by credential.id
  for update;

  update callora.device_credentials
  set lifecycle_state = 'revoked',
      revoked_at = p_revoked_at,
      updated_at = p_revoked_at
  where organization_id = p_organization_id
    and device_id = p_device_id
    and lifecycle_state in ('pending', 'active');
  get diagnostics v_revoked_credential_count = row_count;

  update callora.device_consent_receipts
  set withdrawn_at = p_revoked_at
  where organization_id = p_organization_id
    and device_id = p_device_id
    and withdrawn_at is null;
  get diagnostics v_withdrawn_count = row_count;
  v_consent_withdrawn := v_withdrawn_count > 0;

  update callora.employee_devices
  set status = 'revoked',
      revoked_at = p_revoked_at,
      updated_at = p_revoked_at
  where organization_id = p_organization_id
    and id = p_device_id;

  v_metadata := jsonb_build_object(
    'requestId', p_request_id,
    'deviceId', p_device_id,
    'employeeId', v_device.employee_id,
    'actorUserId', p_actor_user_id,
    'reason', p_reason,
    'revokedCredentialCount', v_revoked_credential_count,
    'consentWithdrawn', v_consent_withdrawn
  );
  v_response := jsonb_build_object(
    'requestId', p_request_id,
    'deviceId', p_device_id,
    'employeeId', v_device.employee_id,
    'revokedAt', p_revoked_at,
    'reason', p_reason,
    'revokedCredentialCount', v_revoked_credential_count,
    'consentWithdrawn', v_consent_withdrawn
  );

  insert into callora.audit_events (
    id, organization_id, actor_user_id, action, entity_type, entity_id,
    request_id, metadata, occurred_at, created_at
  ) values (
    p_audit_event_id, p_organization_id, p_actor_user_id,
    'device.admin_revoked', 'device', p_device_id,
    p_request_id::text, v_metadata, p_revoked_at, p_revoked_at
  );

  insert into callora.outbox_events (
    id, organization_id, aggregate_type, aggregate_id, event_type, payload,
    available_at, created_at, updated_at
  ) values (
    p_outbox_event_id, p_organization_id, 'device', p_device_id,
    'device.admin_revoked', v_metadata,
    p_revoked_at, p_revoked_at, p_revoked_at
  );

  insert into callora.device_admin_revocations (
    organization_id, request_id, device_id, employee_id, actor_user_id,
    request_fingerprint, reason, revoked_credential_count, consent_withdrawn,
    audit_event_id, outbox_event_id, response_body, completed_at, created_at
  ) values (
    p_organization_id, p_request_id, p_device_id, v_device.employee_id,
    p_actor_user_id, p_request_fingerprint, p_reason,
    v_revoked_credential_count, v_consent_withdrawn,
    p_audit_event_id, p_outbox_event_id, v_response, p_revoked_at, p_revoked_at
  );

  return query select v_response, false;
end
$$;

revoke execute on function callora.admin_revoke_device(
  uuid, uuid, uuid, uuid, uuid, uuid, bytea, text, timestamptz
) from public;
