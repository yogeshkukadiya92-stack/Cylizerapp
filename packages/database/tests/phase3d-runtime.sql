-- Phase 3D runtime-role proof. Run only after migrations, access/roles.sql, and
-- the deterministic development seed in a disposable integration database.
-- Unlike the older catalog smoke check, this file refuses to run as an owner,
-- superuser, or BYPASSRLS role.
do $phase3d_runtime$
declare
  runtime_role record;
  schema_owner name;
  unsafe_tenant_tables text;
  owned_relations text;
  privileged_memberships text;
  unexpected_memberships text;
  unsafe_direct_memberships text;
  unsafe_high_impact_roles text;
  forbidden_login_memberships text;
  has_callora_api boolean;
  visible_organizations integer;
  visible_calls integer;
  inserted_call_id uuid;
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise exception 'Phase 3D requires PostgreSQL 15 or newer';
  end if;

  select
    rolname, rolsuper, rolbypassrls, rolcanlogin, rolinherit,
    rolcreatedb, rolcreaterole, rolreplication
    into runtime_role
  from pg_roles
  where rolname = current_user;

  if runtime_role.rolname is null
     or runtime_role.rolsuper
     or runtime_role.rolbypassrls
     or runtime_role.rolcreatedb
     or runtime_role.rolcreaterole
     or runtime_role.rolreplication
     or not runtime_role.rolcanlogin
     or not runtime_role.rolinherit then
    raise exception 'runtime verification requires LOGIN INHERIT with NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  end if;

  select string_agg(capability_role.rolname, ', ' order by capability_role.rolname)
    into unsafe_high_impact_roles
  from pg_roles as capability_role
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
    raise exception 'writer/migrator roles have unsafe attributes: %', unsafe_high_impact_roles;
  end if;

  select string_agg(
      granted_role.rolname || '[admin=' ||
      coalesce(to_jsonb(membership)->>'admin_option', 'false') || ',inherit=' ||
      coalesce(to_jsonb(membership)->>'inherit_option', 'n/a') || ',set=' ||
      coalesce(to_jsonb(membership)->>'set_option', 'n/a') || ']',
      ', ' order by granted_role.rolname
    )
    into unsafe_direct_memberships
  from pg_auth_members as membership
  join pg_roles as granted_role on granted_role.oid = membership.roleid
  where membership.member = (select oid from pg_roles where rolname = current_user)
    and (
      coalesce((to_jsonb(membership)->>'admin_option')::boolean, false)
      or (
        current_setting('server_version_num')::integer >= 160000
        and granted_role.rolname = 'callora_api'
        and (
          not coalesce((to_jsonb(membership)->>'inherit_option')::boolean, false)
          or not coalesce((to_jsonb(membership)->>'set_option')::boolean, false)
        )
      )
    );
  if unsafe_direct_memberships is not null then
    raise exception 'runtime role has unsafe ADMIN or non-capability membership options: %',
      unsafe_direct_memberships;
  end if;
  -- A runtime LOGIN receives exactly one Callora capability role. This is a
  -- transitive allowlist, so nesting an ingest/worker/auditor/writer/migrator
  -- role below another group cannot bypass the gate.
  with recursive inherited_roles(role_oid) as (
    select membership.roleid
    from pg_auth_members as membership
    where membership.member = (select oid from pg_roles where rolname = current_user)
      and (
        current_setting('server_version_num')::integer < 160000
        or coalesce((to_jsonb(membership)->>'admin_option')::boolean, false)
        or coalesce((to_jsonb(membership)->>'inherit_option')::boolean, false)
        or coalesce((to_jsonb(membership)->>'set_option')::boolean, false)
      )
    union
    select membership.roleid
    from inherited_roles
    join pg_auth_members as membership on membership.member = inherited_roles.role_oid
    where current_setting('server_version_num')::integer < 160000
      or coalesce((to_jsonb(membership)->>'admin_option')::boolean, false)
      or coalesce((to_jsonb(membership)->>'inherit_option')::boolean, false)
      or coalesce((to_jsonb(membership)->>'set_option')::boolean, false)
  )
  select
    coalesce(bool_or(role_definition.rolname = 'callora_api'), false),
    string_agg(role_definition.rolname, ', ' order by role_definition.rolname)
      filter (where role_definition.rolname <> 'callora_api')
    into has_callora_api, unexpected_memberships
  from inherited_roles
  join pg_roles as role_definition on role_definition.oid = inherited_roles.role_oid;
  if not has_callora_api then
    raise exception 'runtime role must have an actual direct or transitive callora_api grant';
  end if;
  if unexpected_memberships is not null then
    raise exception 'runtime role has unexpected direct or transitive memberships (only callora_api is allowed): %',
      unexpected_memberships;
  end if;

  with recursive inherited_roles(role_oid) as (
    select membership.roleid
    from pg_auth_members as membership
    where membership.member = (select oid from pg_roles where rolname = current_user)
      and (
        current_setting('server_version_num')::integer < 160000
        or coalesce((to_jsonb(membership)->>'admin_option')::boolean, false)
        or coalesce((to_jsonb(membership)->>'inherit_option')::boolean, false)
        or coalesce((to_jsonb(membership)->>'set_option')::boolean, false)
      )
    union
    select membership.roleid
    from inherited_roles
    join pg_auth_members as membership on membership.member = inherited_roles.role_oid
    where current_setting('server_version_num')::integer < 160000
      or coalesce((to_jsonb(membership)->>'admin_option')::boolean, false)
      or coalesce((to_jsonb(membership)->>'inherit_option')::boolean, false)
      or coalesce((to_jsonb(membership)->>'set_option')::boolean, false)
  )
  select string_agg(role_definition.rolname, ', ' order by role_definition.rolname)
    into privileged_memberships
  from inherited_roles
  join pg_roles as role_definition on role_definition.oid = inherited_roles.role_oid
  where (
      role_definition.rolsuper
      or role_definition.rolbypassrls
      or role_definition.rolcreatedb
      or role_definition.rolcreaterole
      or role_definition.rolreplication
    );
  if privileged_memberships is not null then
    raise exception 'runtime role inherits privileged role memberships: %', privileged_memberships;
  end if;

  -- The writer owns SECURITY DEFINER call-log functions and must never be
  -- reachable by a LOGIN. The migrator is short-lived and must have zero LOGIN
  -- capability paths before normal release verification is accepted. On PG16+
  -- ADMIN-only edges with INHERIT/SET disabled are control paths, not data
  -- capability. pg_has_role would falsely treat every superuser as an implicit
  -- member even when no grant exists.
  with recursive actual_memberships(login_oid, granted_role_oid) as (
    select login_role.oid, membership.roleid
    from pg_roles as login_role
    join pg_auth_members as membership on membership.member = login_role.oid
    join pg_roles as directly_granted_role on directly_granted_role.oid = membership.roleid
    join pg_database as database_definition on database_definition.datname = current_database()
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
    select actual_memberships.login_oid, membership.roleid
    from actual_memberships
    join pg_auth_members as membership
      on membership.member = actual_memberships.granted_role_oid
    where current_setting('server_version_num')::integer < 160000
      or coalesce((to_jsonb(membership)->>'admin_option')::boolean, false)
      or coalesce((to_jsonb(membership)->>'inherit_option')::boolean, false)
      or coalesce((to_jsonb(membership)->>'set_option')::boolean, false)
  )
  select string_agg(
      login_role.rolname || '->' || capability_role.rolname,
      ', ' order by login_role.rolname, capability_role.rolname
    )
    into forbidden_login_memberships
  from actual_memberships
  join pg_roles as login_role on login_role.oid = actual_memberships.login_oid
  join pg_roles as capability_role on capability_role.oid = actual_memberships.granted_role_oid
  where capability_role.rolname in ('callora_call_writer', 'callora_pii_migrator');
  if forbidden_login_memberships is not null then
    raise exception 'forbidden LOGIN membership remains after bootstrap/backfill revocation: %',
      forbidden_login_memberships;
  end if;

  select owner_role.rolname
    into schema_owner
  from pg_namespace as namespace
  join pg_roles as owner_role on owner_role.oid = namespace.nspowner
  where namespace.nspname = 'callora';

  if schema_owner is null or pg_has_role(current_user, schema_owner, 'member') then
    raise exception 'runtime role must not own or inherit the Callora schema owner';
  end if;
  if has_schema_privilege(current_user, 'callora', 'CREATE') then
    raise exception 'runtime role must not have CREATE privilege on the Callora schema';
  end if;

  select string_agg(relation.relname, ', ' order by relation.relname)
    into owned_relations
  from pg_class as relation
  where relation.relnamespace = 'callora'::regnamespace
    and relation.relkind in ('r', 'p', 'v', 'm', 'S')
    and pg_has_role(current_user, relation.relowner, 'member');
  if owned_relations is not null then
    raise exception 'runtime role owns or inherits Callora relations: %', owned_relations;
  end if;

  -- Digest-only resolver directories deliberately do not carry tenant RLS;
  -- runtime has no table privilege and reaches them only through narrow
  -- SECURITY DEFINER functions. Every other organization-bearing table must
  -- have both FORCE RLS and at least one policy.
  select string_agg(relation.relname, ', ' order by relation.relname)
    into unsafe_tenant_tables
  from pg_class as relation
  where relation.relnamespace = 'callora'::regnamespace
    and relation.relkind in ('r', 'p')
    and relation.relname not in (
      'pairing_code_resolutions',
      'device_credential_resolutions',
      'device_credential_request_resolutions'
    )
    and exists (
      select 1
      from pg_attribute as attribute
      where attribute.attrelid = relation.oid
        and attribute.attname = 'organization_id'
        and attribute.attnum > 0
        and not attribute.attisdropped
    )
    and (
      not relation.relrowsecurity
      or not relation.relforcerowsecurity
      or not exists (select 1 from pg_policy as policy where policy.polrelid = relation.oid)
    );
  if unsafe_tenant_tables is not null then
    raise exception 'organization-bearing tables lack FORCE RLS or a policy: %', unsafe_tenant_tables;
  end if;

  if has_table_privilege(current_user, 'callora.device_credential_requests', 'SELECT')
     or has_table_privilege(current_user, 'callora.device_credential_requests', 'INSERT')
     or has_table_privilege(current_user, 'callora.device_credential_requests', 'UPDATE')
     or has_table_privilege(current_user, 'callora.device_credential_requests', 'DELETE')
     or has_table_privilege(current_user, 'callora.device_credential_resolutions', 'SELECT')
     or has_table_privilege(current_user, 'callora.device_credential_request_resolutions', 'SELECT')
     or has_table_privilege(current_user, 'callora.mobile_rate_limits', 'SELECT')
     or has_table_privilege(current_user, 'callora.mobile_rate_limits', 'INSERT')
     or has_table_privilege(current_user, 'callora.mobile_rate_limits', 'UPDATE')
     or has_table_privilege(current_user, 'callora.mobile_rate_limits', 'DELETE') then
    raise exception 'runtime role has forbidden direct credential-directory or limiter privileges';
  end if;

  if has_table_privilege(current_user, 'callora.call_logs', 'INSERT')
     or has_table_privilege(current_user, 'callora.call_logs', 'UPDATE')
     or has_table_privilege(current_user, 'callora.call_logs', 'DELETE')
     or has_table_privilege(current_user, 'callora.call_logs', 'TRUNCATE') then
    raise exception 'runtime role can bypass encrypted-only call-log functions or truncate tenant data';
  end if;

  if not has_function_privilege(
    current_user,
    'callora.consume_mobile_rate_limit(bytea,text,integer,integer,timestamptz)',
    'EXECUTE'
  ) or not has_function_privilege(
    current_user,
    'callora.prepare_device_credential_request(uuid,uuid,uuid,uuid,text,bytea,uuid,bytea,timestamptz,uuid,uuid,timestamptz)',
    'EXECUTE'
  ) or not has_function_privilege(
    current_user,
    'callora.upsert_mobile_call_encrypted(uuid,uuid,uuid,uuid,text,text,text,bytea,bytea,bytea,smallint,integer,integer,timestamptz,timestamptz,integer,uuid,uuid,text,bytea,bytea,bytea,timestamptz,timestamptz,integer,boolean,boolean,text,timestamptz)',
    'EXECUTE'
  ) or not has_function_privilege(
    current_user,
    'callora.insert_manual_call_encrypted(uuid,uuid,uuid,uuid,text,text,text,smallint,integer,integer,bytea,bytea,bytea,bytea,bytea,bytea,timestamptz,boolean,timestamptz,timestamptz,timestamptz,integer,integer,boolean,text,timestamptz)',
    'EXECUTE'
  ) then
    raise exception 'runtime role is missing narrow mobile function privileges';
  end if;

  if has_function_privilege(
    current_user,
    'callora.upsert_mobile_call_encrypted(uuid,uuid,uuid,uuid,text,text,text,bytea,bytea,bytea,smallint,integer,timestamptz,timestamptz,integer,uuid,uuid,text,bytea,bytea,bytea,timestamptz,timestamptz,integer,boolean,boolean,text,timestamptz)',
    'EXECUTE'
  ) or has_function_privilege(
    current_user,
    'callora.insert_manual_call_encrypted(uuid,uuid,uuid,uuid,text,text,text,smallint,integer,bytea,bytea,bytea,bytea,bytea,bytea,timestamptz,boolean,timestamptz,timestamptz,timestamptz,integer,integer,boolean,text,timestamptz)',
    'EXECUTE'
  ) then
    raise exception 'runtime role retains a legacy implicit-blind-version call writer grant';
  end if;

  perform set_config('app.current_organization_id', '00000000-0000-4000-8000-000000000000', true);
  select count(*) into visible_organizations from callora.organizations;
  select count(*) into visible_calls from callora.call_logs;
  if visible_organizations <> 0 or visible_calls <> 0 then
    raise exception 'unknown tenant context can see rows (organizations %, calls %)',
      visible_organizations, visible_calls;
  end if;

  perform set_config('app.current_organization_id', '10000000-0000-4000-8000-000000000001', true);
  perform set_config('app.current_user_id', '10000000-0000-4000-8000-000000000101', true);
  select count(*) into visible_organizations from callora.organizations;
  select count(*) into visible_calls from callora.call_logs;
  if visible_organizations <> 1 or visible_calls <> 1 then
    raise exception 'tenant A isolation failed (organizations %, calls %)',
      visible_organizations, visible_calls;
  end if;
  if exists (
    select 1 from callora.organizations
    where id = '20000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'tenant A can read tenant B by primary key';
  end if;

  select callora.insert_manual_call_encrypted(
    '10000000-0000-4000-8000-000000000af1'::uuid,
    '10000000-0000-4000-8000-000000000001'::uuid,
    '10000000-0000-4000-8000-000000000501'::uuid,
    null::uuid,
    'phase3d-runtime-encrypted-call',
    'outgoing',
    'answered',
    2::smallint,
    1,
    1,
    decode(repeat('ab', 17), 'hex'),
    decode(repeat('cd', 12), 'hex'),
    decode(repeat('ef', 32), 'hex'),
    null::bytea,
    null::bytea,
    null::bytea,
    statement_timestamp(),
    false,
    statement_timestamp(),
    null::timestamptz,
    null::timestamptz,
    0,
    null::integer,
    true,
    repeat('a', 64),
    statement_timestamp()
  ) into inserted_call_id;
  if inserted_call_id is distinct from '10000000-0000-4000-8000-000000000af1'::uuid
     or not exists (
       select 1 from callora.call_logs
       where id = inserted_call_id
         and phone_number is null
         and phone_number_ciphertext is not null
         and pii_encryption_version = 2
         and pii_blind_index_key_version = 1
     ) then
    raise exception 'encrypted-only manual call function did not persist a protected row';
  end if;

  perform set_config('app.current_organization_id', '20000000-0000-4000-8000-000000000001', true);
  perform set_config('app.current_user_id', '20000000-0000-4000-8000-000000000101', true);
  select count(*) into visible_organizations from callora.organizations;
  select count(*) into visible_calls from callora.call_logs;
  if visible_organizations <> 1 or visible_calls <> 1 then
    raise exception 'tenant B isolation failed (organizations %, calls %)',
      visible_organizations, visible_calls;
  end if;
  if exists (
    select 1 from callora.organizations
    where id = '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'tenant B can read tenant A by primary key';
  end if;
end
$phase3d_runtime$;

select 'Callora Phase 3D non-owner FORCE-RLS verification passed.' as result;
