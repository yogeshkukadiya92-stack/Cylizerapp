-- Run only after every tenant has completed backfill, active-key rotation, and
-- verification while API/call writers remain drained. This operation is
-- deliberately separate from ordered migrations because its data precondition
-- cannot be true until the bounded application-layer transition has finished.
\set ON_ERROR_STOP on

begin;
select pg_advisory_xact_lock(hashtextextended('callora.call-pii-finalize', 0));
set local lock_timeout = '5s';
set local statement_timeout = '30min';

do $membership_proof$
declare
  unsafe_high_impact_roles text;
begin
  if not exists (
    select 1
    from pg_catalog.pg_database as database_definition
    join pg_catalog.pg_roles as owner_role on owner_role.oid = database_definition.datdba
    where database_definition.datname = current_database()
      and owner_role.rolname = current_user
      and owner_role.rolcanlogin
      and owner_role.rolinherit
      and owner_role.rolcreaterole
      and not owner_role.rolsuper
      and not owner_role.rolcreatedb
      and not owner_role.rolreplication
      and not owner_role.rolbypassrls
  ) then
    raise exception 'PII finalization requires the dedicated non-super database-owner role administrator';
  end if;

  select string_agg(capability_role.rolname, ', ' order by capability_role.rolname)
    into unsafe_high_impact_roles
  from pg_catalog.pg_roles as capability_role
  where capability_role.rolname in ('callora_call_writer', 'callora_pii_migrator')
    and (
      capability_role.rolcanlogin
      or capability_role.rolsuper
      or capability_role.rolcreatedb
      or capability_role.rolcreaterole
      or capability_role.rolreplication
      or capability_role.rolinherit
      or capability_role.rolbypassrls
    );
  if unsafe_high_impact_roles is not null then
    raise exception 'writer/migrator roles have unsafe attributes before PII finalization: %',
      unsafe_high_impact_roles;
  end if;

  if exists (
    with recursive membership_closure(login_oid, roleid) as (
      select login_role.oid, membership.roleid
      from pg_catalog.pg_roles as login_role
      join pg_catalog.pg_auth_members as membership on membership.member = login_role.oid
      join pg_catalog.pg_roles as directly_granted_role
        on directly_granted_role.oid = membership.roleid
      join pg_catalog.pg_database as database_definition
        on database_definition.datname = current_database()
      where login_role.rolcanlogin
        and (
          current_setting('server_version_num')::integer < 160000
          or coalesce((to_jsonb(membership)->>'admin_option')::boolean, false)
          or coalesce((to_jsonb(membership)->>'inherit_option')::boolean, false)
          or coalesce((to_jsonb(membership)->>'set_option')::boolean, false)
        )
        and not (
          current_setting('server_version_num')::integer >= 160000
          and login_role.oid = database_definition.datdba
          and directly_granted_role.rolname in ('callora_call_writer', 'callora_pii_migrator')
          and coalesce((to_jsonb(membership)->>'admin_option')::boolean, false)
          and not coalesce((to_jsonb(membership)->>'inherit_option')::boolean, true)
          and not coalesce((to_jsonb(membership)->>'set_option')::boolean, true)
        )
      union
      select inherited.login_oid, parent.roleid
      from membership_closure as inherited
      join pg_catalog.pg_auth_members as parent
        on parent.member = inherited.roleid
      where current_setting('server_version_num')::integer < 160000
        or coalesce((to_jsonb(parent)->>'admin_option')::boolean, false)
        or coalesce((to_jsonb(parent)->>'inherit_option')::boolean, false)
        or coalesce((to_jsonb(parent)->>'set_option')::boolean, false)
    )
    select 1
    from pg_catalog.pg_roles as login_role
    join membership_closure as inherited on inherited.login_oid = login_role.oid
    join pg_catalog.pg_roles as capability_role on capability_role.oid = inherited.roleid
    where login_role.rolcanlogin
      and capability_role.rolname in ('callora_call_writer', 'callora_pii_migrator')
  ) then
    raise exception 'writer or PII migrator still has a LOGIN capability path';
  end if;
end
$membership_proof$;

-- Legacy overloads are owned by the isolated writer after access bootstrap.
-- Enable writer authority only inside this finalization transaction; rollback
-- restores the previous membership automatically on any later failure.
do $enable_callora_writer_finalization$
begin
  if current_setting('server_version_num')::integer >= 160000 then
    execute format(
      'grant %I to %I with admin true, inherit true, set true',
      'callora_call_writer',
      current_user
    );
  else
    execute format('grant %I to %I', 'callora_call_writer', current_user);
  end if;
end
$enable_callora_writer_finalization$;

alter table callora.call_logs
  drop constraint if exists call_logs_pii_encrypted_only;

alter table callora.call_logs
  add constraint call_logs_pii_encrypted_only check (
    pii_encryption_version = 2
    and pii_key_version is not null
    and pii_key_version > 0
    and pii_blind_index_key_version is not null
    and pii_blind_index_key_version > 0
    and pii_encrypted_at is not null
    and phone_number is null
    and contact_name is null
  ) not valid;

-- VALIDATE scans every row independently of application tenant queries. Any
-- remaining plaintext/legacy/format-1 row aborts the transaction and leaves the
-- previous catalog state intact.
alter table callora.call_logs
  validate constraint call_logs_pii_encrypted_only;

do $finalization_proof$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'callora.call_logs'::regclass
      and conname = 'call_logs_pii_encrypted_only'
      and convalidated
  ) then
    raise exception 'call-log PII encrypted-only constraint was not validated';
  end if;
end
$finalization_proof$;

-- Close the compatibility surface after all old application instances have
-- been stopped. The v2 wrappers retain owner-level access to these helpers.
revoke execute on function callora.upsert_mobile_call_encrypted(
  uuid, uuid, uuid, uuid, text, text, text, bytea, bytea, bytea,
  smallint, integer, timestamptz, timestamptz, integer, uuid, uuid, text,
  bytea, bytea, bytea, timestamptz, timestamptz, integer, boolean, boolean,
  text, timestamptz
) from callora_api, callora_ingest;
revoke execute on function callora.insert_manual_call_encrypted(
  uuid, uuid, uuid, uuid, text, text, text, smallint, integer,
  bytea, bytea, bytea, bytea, bytea, bytea, timestamptz, boolean,
  timestamptz, timestamptz, timestamptz, integer, integer, boolean, text,
  timestamptz
) from callora_api;
revoke execute on function callora.backfill_call_pii_encrypted(
  uuid, uuid, smallint, integer, bytea, bytea, bytea, bytea, bytea, bytea,
  timestamptz
) from callora_pii_migrator;

do $disable_callora_writer_finalization$
declare
  invalid_memberships text;
  missing_control_roles text;
begin
  if current_setting('server_version_num')::integer >= 160000 then
    execute format(
      'grant %I to %I with admin true, inherit false, set false',
      'callora_call_writer',
      current_user
    );

    select string_agg(expected.role_name, ', ' order by expected.role_name)
      into missing_control_roles
    from (values ('callora_call_writer'), ('callora_pii_migrator')) as expected(role_name)
    where not exists (
      select 1
      from pg_catalog.pg_auth_members as membership
      join pg_catalog.pg_roles as granted_role on granted_role.oid = membership.roleid
      join pg_catalog.pg_database as database_definition
        on database_definition.datname = current_database()
      where membership.member = database_definition.datdba
        and granted_role.rolname = expected.role_name
        and coalesce((to_jsonb(membership)->>'admin_option')::boolean, false)
        and not coalesce((to_jsonb(membership)->>'inherit_option')::boolean, true)
        and not coalesce((to_jsonb(membership)->>'set_option')::boolean, true)
    );

    if missing_control_roles is not null then
      raise exception 'migration owner lost ADMIN-only control after PII finalization: %', missing_control_roles;
    end if;
  else
    execute format('revoke %I from %I', 'callora_call_writer', current_user);
  end if;

  select string_agg(
      member_role.rolname || '->' || granted_role.rolname,
      ', ' order by member_role.rolname, granted_role.rolname
    )
    into invalid_memberships
  from pg_catalog.pg_auth_members as membership
  join pg_catalog.pg_roles as granted_role on granted_role.oid = membership.roleid
  join pg_catalog.pg_roles as member_role on member_role.oid = membership.member
  join pg_catalog.pg_database as database_definition
    on database_definition.datname = current_database()
  where granted_role.rolname in ('callora_call_writer', 'callora_pii_migrator')
    and not (
      current_setting('server_version_num')::integer >= 160000
      and member_role.oid = database_definition.datdba
      and coalesce((to_jsonb(membership)->>'admin_option')::boolean, false)
      and not coalesce((to_jsonb(membership)->>'inherit_option')::boolean, true)
      and not coalesce((to_jsonb(membership)->>'set_option')::boolean, true)
    );

  if invalid_memberships is not null then
    raise exception 'writer or PII migrator capability remains after finalization cleanup: %', invalid_memberships;
  end if;
end
$disable_callora_writer_finalization$;

commit;

select 'call-log PII encrypted-only constraint validated' as finalization_status;
