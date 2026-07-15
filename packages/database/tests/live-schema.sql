-- Run after migrations and seed/dev.sql. A non-superuser/non-BYPASSRLS role is
-- required for the data-isolation assertions; catalog assertions always run.
do $$
declare
  missing_tables text;
  unprotected_tables text;
  invalid_indexes text;
begin
  with required(table_name) as (
    values
      ('organizations'),
      ('users'),
      ('roles'),
      ('organization_memberships'),
      ('role_permissions'),
      ('membership_roles'),
      ('user_identities'),
      ('teams'),
      ('employees'),
      ('employee_devices'),
      ('sim_cards'),
      ('device_pairing_codes'),
      ('device_consent_receipts'),
      ('device_credentials'),
      ('device_credential_requests'),
      ('device_admin_revocations'),
      ('call_ingest_batches'),
      ('call_logs'),
      ('call_notes'),
      ('audit_events'),
      ('api_idempotency_keys'),
      ('outbox_events'),
      ('pairing_code_resolutions'),
      ('device_credential_resolutions'),
      ('device_credential_request_resolutions'),
      ('mobile_collection_policies'),
      ('mobile_rate_limits')
  )
  select string_agg(required.table_name, ', ' order by required.table_name)
    into missing_tables
  from required
  left join pg_class as relation
    on relation.relname = required.table_name
   and relation.relnamespace = 'callora'::regnamespace
   and relation.relkind = 'r'
  where relation.oid is null;

  if missing_tables is not null then
    raise exception 'missing Callora tables: %', missing_tables;
  end if;

  with required(table_name) as (
    values
      ('organizations'),
      ('users'),
      ('roles'),
      ('organization_memberships'),
      ('role_permissions'),
      ('membership_roles'),
      ('user_identities'),
      ('teams'),
      ('employees'),
      ('employee_devices'),
      ('sim_cards'),
      ('device_pairing_codes'),
      ('device_consent_receipts'),
      ('device_credentials'),
      ('device_credential_requests'),
      ('device_admin_revocations'),
      ('call_ingest_batches'),
      ('call_logs'),
      ('call_notes'),
      ('audit_events'),
      ('api_idempotency_keys'),
      ('outbox_events')
  )
  select string_agg(required.table_name, ', ' order by required.table_name)
    into unprotected_tables
  from required
  join pg_class as relation
    on relation.relname = required.table_name
   and relation.relnamespace = 'callora'::regnamespace
  where relation.relrowsecurity is not true
     or relation.relforcerowsecurity is not true;

  if unprotected_tables is not null then
    raise exception 'tables missing ENABLE/FORCE RLS: %', unprotected_tables;
  end if;

  select string_agg(index_relation.relname, ', ' order by index_relation.relname)
    into invalid_indexes
  from pg_index as index_metadata
  join pg_class as index_relation on index_relation.oid = index_metadata.indexrelid
  join pg_class as table_relation on table_relation.oid = index_metadata.indrelid
  where table_relation.relnamespace = 'callora'::regnamespace
    and index_metadata.indisvalid is not true;

  if invalid_indexes is not null then
    raise exception 'invalid Callora indexes: %', invalid_indexes;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'callora.call_logs'::regclass
      and conname = 'call_logs_device_external_key'
      and contype = 'u'
  ) then
    raise exception 'call log idempotency constraint is missing';
  end if;

  if to_regprocedure(
    'callora.upsert_mobile_call(uuid,uuid,uuid,text,text,text,text,timestamptz,integer,uuid,uuid,text,text,timestamptz,timestamptz,integer,boolean,boolean,text,timestamptz)'
  ) is null then
    raise exception 'atomic mobile call upsert function is missing';
  end if;

  if to_regprocedure(
    'callora.upsert_mobile_call_encrypted(uuid,uuid,uuid,uuid,text,text,text,bytea,bytea,bytea,smallint,integer,timestamptz,timestamptz,integer,uuid,uuid,text,bytea,bytea,bytea,timestamptz,timestamptz,integer,boolean,boolean,text,timestamptz)'
  ) is null then
    raise exception 'encrypted-only mobile call upsert function is missing';
  end if;

  if to_regprocedure(
    'callora.upsert_mobile_call_encrypted(uuid,uuid,uuid,uuid,text,text,text,bytea,bytea,bytea,smallint,integer,integer,timestamptz,timestamptz,integer,uuid,uuid,text,bytea,bytea,bytea,timestamptz,timestamptz,integer,boolean,boolean,text,timestamptz)'
  ) is null then
    raise exception 'blind-versioned mobile call upsert function is missing';
  end if;

  if to_regprocedure(
    'callora.insert_manual_call_encrypted(uuid,uuid,uuid,uuid,text,text,text,smallint,integer,bytea,bytea,bytea,bytea,bytea,bytea,timestamptz,boolean,timestamptz,timestamptz,timestamptz,integer,integer,boolean,text,timestamptz)'
  ) is null then
    raise exception 'encrypted-only manual call insert function is missing';
  end if;

  if to_regprocedure(
    'callora.insert_manual_call_encrypted(uuid,uuid,uuid,uuid,text,text,text,smallint,integer,integer,bytea,bytea,bytea,bytea,bytea,bytea,timestamptz,boolean,timestamptz,timestamptz,timestamptz,integer,integer,boolean,text,timestamptz)'
  ) is null then
    raise exception 'blind-versioned manual call insert function is missing';
  end if;

  if to_regprocedure(
    'callora.backfill_call_pii_encrypted(uuid,uuid,smallint,integer,bytea,bytea,bytea,bytea,bytea,bytea,timestamptz)'
  ) is null then
    raise exception 'one-way call PII backfill function is missing';
  end if;

  if to_regprocedure(
    'callora.backfill_call_pii_encrypted(uuid,uuid,smallint,integer,integer,bytea,bytea,bytea,bytea,bytea,bytea,timestamptz)'
  ) is null then
    raise exception 'blind-versioned call PII backfill function is missing';
  end if;

  if to_regprocedure('callora.claim_call_pii_backfill_batch(uuid,integer)') is null then
    raise exception 'bounded call PII backfill claim function is missing';
  end if;

  if to_regprocedure(
    'callora.claim_call_pii_rotation_batch(uuid,smallint,integer,integer,integer)'
  ) is null or to_regprocedure(
    'callora.rotate_call_pii_encrypted(uuid,uuid,smallint,integer,integer,smallint,integer,integer,bytea,bytea,bytea,bytea,bytea,bytea,timestamptz)'
  ) is null then
    raise exception 'bounded call PII key-rotation functions are missing';
  end if;

  if to_regprocedure('callora.resolve_pairing_code_organization(bytea)') is null then
    raise exception 'pairing-code organization resolver is missing';
  end if;

  if to_regprocedure('callora.resolve_device_credential(bytea,text)') is null then
    raise exception 'device credential organization resolver is missing';
  end if;

  if to_regprocedure('callora.resolve_mobile_collection_policy(text,text,timestamptz)') is null then
    raise exception 'mobile collection policy resolver is missing';
  end if;

  if to_regprocedure('callora.resolve_pairing_redemption_replay(bytea,uuid,bytea)') is null
     or to_regprocedure('callora.resolve_device_credential_replay(bytea,uuid,text,bytea)') is null
     or to_regprocedure('callora.resolve_pending_rotation_credential(bytea,uuid,uuid,bytea)') is null then
    raise exception 'request-bound mobile credential replay resolver is missing';
  end if;

  if to_regprocedure(
    'callora.prepare_device_credential_request(uuid,uuid,uuid,uuid,text,bytea,uuid,bytea,timestamptz,uuid,uuid,timestamptz)'
  ) is null
     or to_regprocedure(
       'callora.confirm_device_session_rotation(uuid,uuid,uuid,uuid,uuid,uuid,bytea,timestamptz)'
     ) is null
     or to_regprocedure(
       'callora.revoke_device_session_request(uuid,uuid,uuid,uuid,uuid,bytea,timestamptz)'
     ) is null then
    raise exception 'mobile credential transition functions are missing';
  end if;

  if to_regprocedure(
    'callora.accept_device_collection_policy(uuid,uuid,uuid,uuid,uuid,bytea,uuid,bytea,jsonb,text,timestamptz,timestamptz)'
  ) is null
     or to_regprocedure(
       'callora.reconsent_device_collection_policy(uuid,uuid,uuid,uuid,uuid,bytea,uuid,bytea,jsonb,text,timestamptz,timestamptz)'
     ) is null then
    raise exception 'server-authoritative mobile consent transitions are missing';
  end if;

  if to_regprocedure(
    'callora.consume_mobile_rate_limit(bytea,text,integer,integer,timestamptz)'
  ) is null
     or to_regprocedure('callora.reset_mobile_rate_limit(bytea,text)') is null then
    raise exception 'atomic mobile rate-limit functions are missing';
  end if;

  if to_regprocedure(
    'callora.device_has_current_collection_consent(uuid,uuid,timestamptz)'
  ) is null then
    raise exception 'current mobile policy consent check is missing';
  end if;

  if to_regprocedure(
    'callora.admin_revoke_device(uuid,uuid,uuid,uuid,uuid,uuid,bytea,text,timestamptz)'
  ) is null then
    raise exception 'atomic administrator device recovery function is missing';
  end if;

  if not exists (
    select 1
    from pg_class as index_relation
    join pg_index as index_metadata on index_metadata.indexrelid = index_relation.oid
    where index_relation.relnamespace = 'callora'::regnamespace
      and index_relation.relname = 'mobile_collection_policies_unretired_key'
      and index_metadata.indisunique
      and index_metadata.indpred is not null
  ) then
    raise exception 'one-unretired-mobile-policy index is missing';
  end if;

  if (
    select count(*)
    from (values
      ('synthetic_demo'::text, '30000000-0000-4000-8000-000000000001'::uuid),
      ('android_call_log'::text, '30000000-0000-4000-8000-000000000002'::uuid)
    ) as expected(collection_mode, policy_id)
    cross join lateral callora.resolve_mobile_collection_policy(
      expected.collection_mode, 'call_metadata', clock_timestamp()
    ) as policy
    where policy.id = expected.policy_id and octet_length(policy.content_hash) = 32
  ) <> 2 then
    raise exception 'seeded mobile collection policies are missing or invalid';
  end if;

  if (
    select count(*)
    from pg_constraint
    where conrelid in (
      'callora.device_consent_receipts'::regclass,
      'callora.device_credentials'::regclass,
      'callora.device_credential_requests'::regclass
    )
      and conname in (
        'device_consent_receipts_permissions_complete',
        'device_consent_receipts_employee_device_fk',
        'device_credentials_employee_device_fk',
        'device_credentials_rotated_from_device_fk',
        'device_credentials_ttl_valid',
        'device_credentials_lifecycle_state_valid',
        'device_credential_requests_fingerprint_length'
      )
  ) <> 7 then
    raise exception 'mobile consent or credential integrity constraints are missing';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'callora.user_identities'::regclass
      and conname = 'user_identities_oidc_key'
      and contype = 'u'
  ) then
    raise exception 'tenant-scoped OIDC identity key is missing';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'callora.api_idempotency_keys'::regclass
      and conname = 'api_idempotency_keys_tenant_scope_key'
      and contype = 'u'
  ) then
    raise exception 'API idempotency key is missing';
  end if;
end
$$;

do $$
declare
  role_bypasses_rls boolean;
  visible_organizations integer;
  visible_calls integer;
begin
  select role_definition.rolsuper or role_definition.rolbypassrls
    into role_bypasses_rls
  from pg_roles as role_definition
  where role_definition.rolname = current_user;

  if role_bypasses_rls then
    raise notice 'tenant data assertions skipped because role % bypasses RLS', current_user;
    return;
  end if;

  perform set_config(
    'app.current_organization_id',
    '10000000-0000-4000-8000-000000000001',
    true
  );
  select count(*) into visible_organizations from callora.organizations;
  select count(*) into visible_calls from callora.call_logs;
  if visible_organizations <> 1 or visible_calls <> 1 then
    raise exception
      'tenant A isolation failed (organizations %, calls %); run the development seed first',
      visible_organizations,
      visible_calls;
  end if;

  perform set_config(
    'app.current_organization_id',
    '20000000-0000-4000-8000-000000000001',
    true
  );
  select count(*) into visible_organizations from callora.organizations;
  select count(*) into visible_calls from callora.call_logs;
  if visible_organizations <> 1 or visible_calls <> 1 then
    raise exception
      'tenant B isolation failed (organizations %, calls %); run the development seed first',
      visible_organizations,
      visible_calls;
  end if;
end
$$;

select 'Callora live schema verification passed.' as result;
