-- Run once as a database owner or role administrator, then grant one of these
-- NOLOGIN roles to the application's LOGIN roles. None can bypass RLS.
begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'callora_api') then
    create role callora_api nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'callora_ingest') then
    create role callora_ingest nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'callora_auditor') then
    create role callora_auditor nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'callora_worker') then
    create role callora_worker nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'callora_call_writer') then
    create role callora_call_writer nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'callora_pii_migrator') then
    create role callora_pii_migrator nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end
$$;

-- A non-superuser CREATEROLE administrator may enforce only these role
-- attributes. PostgreSQL reserves SUPERUSER, REPLICATION, and BYPASSRLS
-- changes (including their NO... forms) for a superuser, so verify those
-- restricted attributes separately and fail closed below.
alter role callora_api nologin nocreaterole noinherit;
alter role callora_ingest nologin nocreaterole noinherit;
alter role callora_auditor nologin nocreaterole noinherit;
alter role callora_worker nologin nocreaterole noinherit;
alter role callora_call_writer nologin nocreaterole noinherit;
alter role callora_pii_migrator nologin nocreaterole noinherit;

do $assert_callora_role_attributes$
declare
  unsafe_roles text;
begin
  select string_agg(role_definition.rolname, ', ' order by role_definition.rolname)
    into unsafe_roles
  from pg_roles as role_definition
  where role_definition.rolname in (
      'callora_api',
      'callora_ingest',
      'callora_auditor',
      'callora_worker',
      'callora_call_writer',
      'callora_pii_migrator'
    )
    and (
      role_definition.rolcanlogin
      or role_definition.rolsuper
      or role_definition.rolcreatedb
      or role_definition.rolcreaterole
      or role_definition.rolreplication
      or role_definition.rolinherit
      or role_definition.rolbypassrls
    );

  if unsafe_roles is not null then
    raise exception 'Callora group roles have unsafe attributes: %', unsafe_roles
      using hint = 'Repair SUPERUSER, REPLICATION, or BYPASSRLS attributes as a superuser, then rerun this bootstrap.';
  end if;
end
$assert_callora_role_attributes$;

-- Repair a dirty catalog instead of trusting an earlier manual grant. On
-- PostgreSQL 15 neither high-impact role has a persistent member. PostgreSQL
-- 16+ requires a non-superuser role administrator to retain ADMIN OPTION on
-- roles it manages, so only the current migration owner keeps an ADMIN-only
-- control grant with INHERIT and SET disabled. Every other membership is
-- removed. to_jsonb keeps the PG16 membership-option checks parse-safe on 15.
do $purge_callora_pii_role_memberships$
declare
  stale_membership record;
  control_role record;
  invalid_memberships text;
  missing_control_roles text;
  server_version_number integer := current_setting('server_version_num')::integer;
  migration_owner name := current_user;
begin
  for stale_membership in
    select distinct
      granted_role.rolname as granted_role,
      member_role.rolname as member_role
    from pg_auth_members as membership
    join pg_roles as granted_role on granted_role.oid = membership.roleid
    join pg_roles as member_role on member_role.oid = membership.member
    where granted_role.rolname in ('callora_call_writer', 'callora_pii_migrator')
      and (
        server_version_number < 160000
        or member_role.rolname <> migration_owner
      )
  loop
    execute format(
      'revoke %I from %I cascade',
      stale_membership.granted_role,
      stale_membership.member_role
    );
  end loop;

  if server_version_number >= 160000 then
    for control_role in
      select role_name
      from (values ('callora_call_writer'), ('callora_pii_migrator')) as expected(role_name)
    loop
      execute format(
        'grant %I to %I with admin true, inherit false, set false',
        control_role.role_name,
        migration_owner
      );
    end loop;
  end if;

  select string_agg(
      format(
        '%I->%I[admin=%s,inherit=%s,set=%s]',
        member_role.rolname,
        granted_role.rolname,
        coalesce(to_jsonb(membership) ->> 'admin_option', 'false'),
        coalesce(to_jsonb(membership) ->> 'inherit_option', 'n/a'),
        coalesce(to_jsonb(membership) ->> 'set_option', 'n/a')
      ),
      ', '
      order by granted_role.rolname, member_role.rolname
    )
    into invalid_memberships
  from pg_auth_members as membership
  join pg_roles as granted_role on granted_role.oid = membership.roleid
  join pg_roles as member_role on member_role.oid = membership.member
  where granted_role.rolname in ('callora_call_writer', 'callora_pii_migrator')
    and (
      server_version_number < 160000
      or member_role.rolname <> migration_owner
      or coalesce((to_jsonb(membership) ->> 'admin_option')::boolean, false) is not true
      or coalesce((to_jsonb(membership) ->> 'inherit_option')::boolean, true) is not false
      or coalesce((to_jsonb(membership) ->> 'set_option')::boolean, true) is not false
    );

  if invalid_memberships is not null then
    raise exception 'Unsafe Callora writer/migrator memberships remain after repair: %', invalid_memberships
      using hint = 'PostgreSQL 16+ requires the migration owner to hold an independent ADMIN-only grant from a controlling role or superuser.';
  end if;

  if server_version_number >= 160000 then
    select string_agg(expected.role_name, ', ' order by expected.role_name)
      into missing_control_roles
    from (values ('callora_call_writer'), ('callora_pii_migrator')) as expected(role_name)
    where not exists (
      select 1
      from pg_auth_members as membership
      join pg_roles as granted_role on granted_role.oid = membership.roleid
      join pg_roles as member_role on member_role.oid = membership.member
      where granted_role.rolname = expected.role_name
        and member_role.rolname = migration_owner
        and coalesce((to_jsonb(membership) ->> 'admin_option')::boolean, false)
        and not coalesce((to_jsonb(membership) ->> 'inherit_option')::boolean, true)
        and not coalesce((to_jsonb(membership) ->> 'set_option')::boolean, true)
    );

    if missing_control_roles is not null then
      raise exception 'Migration owner is missing ADMIN-only control of Callora roles: %', missing_control_roles;
    end if;
  end if;
end
$purge_callora_pii_role_memberships$;

-- A replay may encounter SECURITY DEFINER routines already owned by the
-- isolated writer. Temporarily regain that ownership authority before ACL
-- repair, keep it only through the owner assignments below, then remove the
-- capability in this same transaction. PG16+ retains only ADMIN control.
do $enable_callora_writer_maintenance$
declare
  server_version_number integer := current_setting('server_version_num')::integer;
begin
  if server_version_number >= 160000 then
    execute format(
      'grant %I to %I with admin true, inherit true, set true',
      'callora_call_writer',
      current_user
    );
  else
    execute format('grant %I to %I', 'callora_call_writer', current_user);
  end if;
end
$enable_callora_writer_maintenance$;

-- pg_dump --no-privileges intentionally omits routine ACLs. Revoke the
-- PostgreSQL default PUBLIC EXECUTE grant from every Callora SECURITY DEFINER
-- routine on every bootstrap, including after a restore, before selectively
-- granting the exact runtime entry points below.
do $revoke_public_security_definer_execute$
declare
  security_definer record;
begin
  for security_definer in
    select
      procedure_definition.prokind,
      procedure_definition.proname,
      pg_get_function_identity_arguments(procedure_definition.oid) as identity_arguments
    from pg_proc as procedure_definition
    join pg_namespace as namespace
      on namespace.oid = procedure_definition.pronamespace
    where namespace.nspname = 'callora'
      and procedure_definition.prosecdef
  loop
    execute format(
      'revoke execute on %s %I.%I(%s) from public',
      case when security_definer.prokind = 'p' then 'procedure' else 'function' end,
      'callora',
      security_definer.proname,
      security_definer.identity_arguments
    );
  end loop;
end
$revoke_public_security_definer_execute$;

grant usage on schema callora to
  callora_api, callora_ingest, callora_auditor, callora_worker,
  callora_call_writer, callora_pii_migrator;
grant select on callora.permission_definitions to callora_api, callora_auditor;

grant select, insert, update, delete on
  callora.organizations,
  callora.users,
  callora.roles,
  callora.organization_memberships,
  callora.role_permissions,
  callora.membership_roles,
  callora.user_identities,
  callora.teams,
  callora.employees,
  callora.employee_devices,
  callora.sim_cards,
  callora.device_pairing_codes,
  callora.call_ingest_batches,
  callora.call_logs,
  callora.call_notes,
  callora.api_idempotency_keys,
  callora.outbox_events
to callora_api;

grant select on
  callora.device_consent_receipts,
  callora.device_credentials
to callora_api;

grant select, insert on callora.audit_events to callora_api;

-- Phase 4A CRM tables start from a deny-all baseline on every replay. Leads,
-- follow-ups, and correction history use lifecycle transitions instead of
-- destructive deletes; append-only activity history can only be inserted.
revoke all on
  callora.membership_team_scopes,
  callora.lead_statuses,
  callora.leads,
  callora.lead_notes,
  callora.lead_follow_ups,
  callora.lead_activities,
  callora.call_lead_links,
  callora.lead_assignment_rules,
  callora.lead_assignment_rule_employees,
  callora.lead_import_jobs,
  callora.lead_import_rows
from
  callora_api, callora_ingest, callora_auditor, callora_worker,
  callora_call_writer, callora_pii_migrator;

grant select, insert, delete on callora.membership_team_scopes to callora_api;
grant select, insert, update on
  callora.lead_statuses,
  callora.leads,
  callora.lead_notes,
  callora.lead_follow_ups,
  callora.call_lead_links
to callora_api;
grant select, insert on callora.lead_activities to callora_api;
grant select, insert, update on
  callora.lead_assignment_rules,
  callora.lead_import_jobs,
  callora.lead_import_rows
to callora_api;
grant select, insert, update, delete on callora.lead_assignment_rule_employees to callora_api;

grant select on
  callora.organizations,
  callora.employees,
  callora.employee_devices,
  callora.device_consent_receipts,
  callora.device_credentials,
  callora.sim_cards,
  callora.call_ingest_batches,
  callora.call_logs
to callora_ingest;
grant insert, update on
  callora.employee_devices,
  callora.call_ingest_batches,
  callora.call_logs,
  callora.outbox_events
to callora_ingest;
grant insert on callora.audit_events to callora_ingest;

-- Call-log writes are function-only for long-running runtimes. The isolated
-- writer owns the SECURITY DEFINER functions but is never capability-granted
-- to a LOGIN (PG16+ migration control remains ADMIN-only).
-- TRUNCATE bypasses row-level security, so remove any stale direct or inherited
-- table grant from every Callora group role before applying the exact allowlist.
revoke truncate on callora.call_logs from
  callora_api, callora_ingest, callora_auditor, callora_worker,
  callora_call_writer, callora_pii_migrator;
revoke insert, update, delete on callora.call_logs from callora_api, callora_ingest;
grant select, insert, update on callora.call_logs to callora_call_writer;

-- Grant this role only to a short-lived backfill LOGIN, one tenant at a time,
-- then revoke it. It can read legacy PII but transitions rows only via the
-- one-way encrypted backfill function; it has no direct table UPDATE privilege.
grant select on callora.call_logs to callora_pii_migrator;

do $assert_no_callora_call_log_truncate$
declare
  truncating_roles text;
begin
  select string_agg(role_definition.rolname, ', ' order by role_definition.rolname)
    into truncating_roles
  from pg_catalog.pg_roles as role_definition
  where role_definition.rolname in (
      'callora_api',
      'callora_ingest',
      'callora_auditor',
      'callora_worker',
      'callora_call_writer',
      'callora_pii_migrator'
    )
    and has_table_privilege(
      role_definition.oid,
      'callora.call_logs',
      'TRUNCATE'
    );

  if truncating_roles is not null then
    raise exception 'Callora roles retain unsafe call_logs TRUNCATE authority: %', truncating_roles;
  end if;
end
$assert_no_callora_call_log_truncate$;

grant select on
  callora.organizations,
  callora.users,
  callora.roles,
  callora.organization_memberships,
  callora.role_permissions,
  callora.membership_roles,
  callora.membership_team_scopes,
  callora.teams,
  callora.employees,
  callora.employee_devices,
  callora.sim_cards,
  callora.device_pairing_codes,
  callora.device_consent_receipts,
  callora.device_credentials,
  callora.device_credential_requests,
  callora.device_admin_revocations,
  callora.mobile_collection_policies,
  callora.call_ingest_batches,
  callora.call_logs,
  callora.call_notes,
  callora.lead_statuses,
  callora.leads,
  callora.lead_notes,
  callora.lead_follow_ups,
  callora.lead_activities,
  callora.call_lead_links,
  callora.lead_assignment_rules,
  callora.lead_assignment_rule_employees,
  callora.lead_import_jobs,
  callora.lead_import_rows,
  callora.audit_events,
  callora.outbox_events
to callora_auditor;

-- Workers are still tenant-scoped. A scheduler must set one trusted
-- organization context per short claim/delivery transaction.
grant select on callora.organizations to callora_worker;
grant select, insert, update, delete on callora.outbox_events to callora_worker;

grant execute on function callora.current_organization_id()
  to callora_api, callora_ingest, callora_auditor, callora_worker,
  callora_call_writer, callora_pii_migrator;
grant execute on function callora.current_user_id()
  to callora_api, callora_auditor;
grant execute on function callora.current_user_has_permission(text)
  to callora_api;
grant execute on function callora.register_call_ingest_batch(
  uuid, uuid, uuid, text, timestamptz, integer, smallint, text, bytea
) to callora_api, callora_ingest;
revoke execute on function callora.upsert_mobile_call(
  uuid, uuid, uuid, text, text, text, text, timestamptz, integer,
  uuid, uuid, text, text, timestamptz, timestamptz, integer, boolean,
  boolean, text, timestamptz
) from callora_api, callora_ingest;
revoke execute on function callora.upsert_mobile_call_encrypted(
  uuid, uuid, uuid, uuid, text, text, text, bytea, bytea, bytea,
  smallint, integer, timestamptz, timestamptz, integer, uuid, uuid, text,
  bytea, bytea, bytea, timestamptz, timestamptz, integer, boolean, boolean,
  text, timestamptz
) from callora_api, callora_ingest;
grant execute on function callora.upsert_mobile_call_encrypted(
  uuid, uuid, uuid, uuid, text, text, text, bytea, bytea, bytea,
  smallint, integer, integer, timestamptz, timestamptz, integer, uuid, uuid,
  text, bytea, bytea, bytea, timestamptz, timestamptz, integer, boolean,
  boolean, text, timestamptz
) to callora_api, callora_ingest;
revoke execute on function callora.insert_manual_call_encrypted(
  uuid, uuid, uuid, uuid, text, text, text, smallint, integer,
  bytea, bytea, bytea, bytea, bytea, bytea, timestamptz, boolean,
  timestamptz, timestamptz, timestamptz, integer, integer, boolean, text,
  timestamptz
) from callora_api;
grant execute on function callora.insert_manual_call_encrypted(
  uuid, uuid, uuid, uuid, text, text, text, smallint, integer, integer,
  bytea, bytea, bytea, bytea, bytea, bytea, timestamptz, boolean,
  timestamptz, timestamptz, timestamptz, integer, integer, boolean, text,
  timestamptz
) to callora_api;
revoke execute on function callora.backfill_call_pii_encrypted(
  uuid, uuid, smallint, integer, bytea, bytea, bytea, bytea, bytea, bytea,
  timestamptz
) from callora_pii_migrator;
grant execute on function callora.backfill_call_pii_encrypted(
  uuid, uuid, smallint, integer, integer, bytea, bytea, bytea, bytea, bytea,
  bytea, timestamptz
) to callora_pii_migrator;
grant execute on function callora.claim_call_pii_backfill_batch(uuid, integer)
  to callora_pii_migrator;
grant execute on function callora.claim_call_pii_rotation_batch(
  uuid, smallint, integer, integer, integer
) to callora_pii_migrator;
grant execute on function callora.rotate_call_pii_encrypted(
  uuid, uuid, smallint, integer, integer, smallint, integer, integer,
  bytea, bytea, bytea, bytea, bytea, bytea, timestamptz
) to callora_pii_migrator;

-- Security-definer code runs as a dedicated non-login, non-owner table writer,
-- so FORCE RLS remains effective. CREATE and the membership granted before ACL
-- repair are temporary only while this bootstrap runs as the role admin.
grant create on schema callora to callora_call_writer;
alter function callora.upsert_mobile_call_encrypted(
  uuid, uuid, uuid, uuid, text, text, text, bytea, bytea, bytea,
  smallint, integer, timestamptz, timestamptz, integer, uuid, uuid, text,
  bytea, bytea, bytea, timestamptz, timestamptz, integer, boolean, boolean,
  text, timestamptz
) owner to callora_call_writer;
alter function callora.upsert_mobile_call_encrypted(
  uuid, uuid, uuid, uuid, text, text, text, bytea, bytea, bytea,
  smallint, integer, integer, timestamptz, timestamptz, integer, uuid, uuid,
  text, bytea, bytea, bytea, timestamptz, timestamptz, integer, boolean,
  boolean, text, timestamptz
) owner to callora_call_writer;
alter function callora.insert_manual_call_encrypted(
  uuid, uuid, uuid, uuid, text, text, text, smallint, integer,
  bytea, bytea, bytea, bytea, bytea, bytea, timestamptz, boolean,
  timestamptz, timestamptz, timestamptz, integer, integer, boolean, text,
  timestamptz
) owner to callora_call_writer;
alter function callora.insert_manual_call_encrypted(
  uuid, uuid, uuid, uuid, text, text, text, smallint, integer, integer,
  bytea, bytea, bytea, bytea, bytea, bytea, timestamptz, boolean,
  timestamptz, timestamptz, timestamptz, integer, integer, boolean, text,
  timestamptz
) owner to callora_call_writer;
alter function callora.backfill_call_pii_encrypted(
  uuid, uuid, smallint, integer, bytea, bytea, bytea, bytea, bytea, bytea,
  timestamptz
) owner to callora_call_writer;
alter function callora.backfill_call_pii_encrypted(
  uuid, uuid, smallint, integer, integer, bytea, bytea, bytea, bytea, bytea,
  bytea, timestamptz
) owner to callora_call_writer;
alter function callora.claim_call_pii_backfill_batch(uuid, integer)
  owner to callora_call_writer;
alter function callora.claim_call_pii_rotation_batch(
  uuid, smallint, integer, integer, integer
) owner to callora_call_writer;
alter function callora.rotate_call_pii_encrypted(
  uuid, uuid, smallint, integer, integer, smallint, integer, integer,
  bytea, bytea, bytea, bytea, bytea, bytea, timestamptz
) owner to callora_call_writer;
revoke create on schema callora from callora_call_writer;
do $disable_callora_writer_maintenance$
declare
  invalid_memberships text;
  missing_control_roles text;
  server_version_number integer := current_setting('server_version_num')::integer;
  migration_owner name := current_user;
begin
  if server_version_number >= 160000 then
    execute format(
      'grant %I to %I with admin true, inherit false, set false',
      'callora_call_writer',
      migration_owner
    );
  else
    execute format('revoke %I from %I', 'callora_call_writer', migration_owner);
  end if;

  select string_agg(
      format(
        '%I->%I[admin=%s,inherit=%s,set=%s]',
        member_role.rolname,
        granted_role.rolname,
        coalesce(to_jsonb(membership) ->> 'admin_option', 'false'),
        coalesce(to_jsonb(membership) ->> 'inherit_option', 'n/a'),
        coalesce(to_jsonb(membership) ->> 'set_option', 'n/a')
      ),
      ', '
      order by granted_role.rolname, member_role.rolname
    )
    into invalid_memberships
  from pg_auth_members as membership
  join pg_roles as granted_role on granted_role.oid = membership.roleid
  join pg_roles as member_role on member_role.oid = membership.member
  where granted_role.rolname in ('callora_call_writer', 'callora_pii_migrator')
    and (
      server_version_number < 160000
      or member_role.rolname <> migration_owner
      or coalesce((to_jsonb(membership) ->> 'admin_option')::boolean, false) is not true
      or coalesce((to_jsonb(membership) ->> 'inherit_option')::boolean, true) is not false
      or coalesce((to_jsonb(membership) ->> 'set_option')::boolean, true) is not false
    );

  if invalid_memberships is not null then
    raise exception 'Callora writer maintenance capability was not removed: %', invalid_memberships;
  end if;

  if server_version_number >= 160000 then
    select string_agg(expected.role_name, ', ' order by expected.role_name)
      into missing_control_roles
    from (values ('callora_call_writer'), ('callora_pii_migrator')) as expected(role_name)
    where not exists (
      select 1
      from pg_auth_members as membership
      join pg_roles as granted_role on granted_role.oid = membership.roleid
      join pg_roles as member_role on member_role.oid = membership.member
      where granted_role.rolname = expected.role_name
        and member_role.rolname = migration_owner
        and coalesce((to_jsonb(membership) ->> 'admin_option')::boolean, false)
        and not coalesce((to_jsonb(membership) ->> 'inherit_option')::boolean, true)
        and not coalesce((to_jsonb(membership) ->> 'set_option')::boolean, true)
    );

    if missing_control_roles is not null then
      raise exception 'Migration owner lost ADMIN-only control of Callora roles: %', missing_control_roles;
    end if;
  end if;
end
$disable_callora_writer_maintenance$;
grant execute on function callora.resolve_pairing_code_organization(bytea)
  to callora_api;
grant execute on function callora.resolve_device_credential(bytea, text)
  to callora_api, callora_ingest;
grant execute on function callora.resolve_mobile_collection_policy(text, text, timestamptz)
  to callora_api, callora_ingest;
grant execute on function callora.resolve_pairing_redemption_replay(bytea, uuid, bytea)
  to callora_api;
grant execute on function callora.resolve_device_credential_replay(bytea, uuid, text, bytea)
  to callora_api;
grant execute on function callora.resolve_pending_rotation_credential(bytea, uuid, uuid, bytea)
  to callora_api;
grant execute on function callora.prepare_device_credential_request(
  uuid, uuid, uuid, uuid, text, bytea, uuid, bytea,
  timestamptz, uuid, uuid, timestamptz
) to callora_api;
grant execute on function callora.confirm_device_session_rotation(
  uuid, uuid, uuid, uuid, uuid, uuid, bytea, timestamptz
) to callora_api;
grant execute on function callora.revoke_device_session_request(
  uuid, uuid, uuid, uuid, uuid, bytea, timestamptz
) to callora_api;
grant execute on function callora.accept_device_collection_policy(
  uuid, uuid, uuid, uuid, uuid, bytea, uuid, bytea, jsonb,
  text, timestamptz, timestamptz
) to callora_api;
grant execute on function callora.reconsent_device_collection_policy(
  uuid, uuid, uuid, uuid, uuid, bytea, uuid, bytea, jsonb,
  text, timestamptz, timestamptz
) to callora_api;
grant execute on function callora.withdraw_device_consent(
  uuid, uuid, uuid, text, timestamptz
) to callora_api;
grant execute on function callora.consume_mobile_rate_limit(
  bytea, text, integer, integer, timestamptz
) to callora_api;
grant execute on function callora.consume_pairing_redemption_attempt(bytea, timestamptz)
  to callora_api;
grant execute on function callora.reset_mobile_rate_limit(bytea, text)
  to callora_api;
grant execute on function callora.touch_active_device_credential(uuid, uuid, timestamptz)
  to callora_api, callora_ingest;
grant execute on function callora.device_has_current_collection_consent(uuid, uuid, timestamptz)
  to callora_api, callora_ingest;
grant execute on function callora.admin_revoke_device(
  uuid, uuid, uuid, uuid, uuid, uuid, bytea, text, timestamptz
) to callora_api;

revoke insert, update, delete on callora.device_consent_receipts
  from callora_api, callora_ingest;
revoke insert, update, delete on callora.device_credentials
  from callora_api, callora_ingest;
revoke all on callora.device_credential_requests,
  callora.device_credential_request_resolutions,
  callora.device_credential_resolutions,
  callora.device_admin_revocations,
  callora.mobile_rate_limits,
  callora.pairing_redemption_attempts
from callora_api, callora_ingest;

commit;
