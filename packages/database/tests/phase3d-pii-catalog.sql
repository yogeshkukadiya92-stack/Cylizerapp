-- Exact live-catalog gate for the call-log PII transition. Run after every
-- migration and access/roles.sql through a non-owner runtime LOGIN.
do $phase3d_pii_catalog$
declare
  invalid_indexes text;
  invalid_functions text;
  public_security_definers text;
  representation_constraint_valid boolean;
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise exception 'Phase 3D PII catalog verification requires PostgreSQL 15 or newer';
  end if;

  with expected(index_name, is_unique, key_names, key_options, predicate) as (
    values
      (
        'call_logs_phone_nonce_unique', true,
        array['pii_key_version', 'phone_number_nonce']::text[],
        array[0, 0]::smallint[],
        'phone_number_nonceISNOTNULL'
      ),
      (
        'call_logs_contact_nonce_unique', true,
        array['pii_key_version', 'contact_name_nonce']::text[],
        array[0, 0]::smallint[],
        'contact_name_nonceISNOTNULL'
      ),
      (
        'call_logs_phone_blind_started_keyset_idx', false,
        array[
          'organization_id', 'pii_blind_index_key_version',
          'phone_number_blind_index', 'started_at', 'id'
        ]::text[],
        array[0, 0, 0, 3, 3]::smallint[],
        'phone_number_blind_indexISNOTNULL'
      ),
      (
        'call_logs_contact_blind_started_keyset_idx', false,
        array[
          'organization_id', 'pii_blind_index_key_version',
          'contact_name_blind_index', 'started_at', 'id'
        ]::text[],
        array[0, 0, 0, 3, 3]::smallint[],
        'contact_name_blind_indexISNOTNULL'
      )
  ),
  actual as (
    select
      index_relation.relname as index_name,
      index_metadata.indisunique as is_unique,
      index_metadata.indisvalid,
      index_metadata.indisready,
      index_metadata.indislive,
      access_method.amname as access_method,
      index_metadata.indnatts,
      index_metadata.indnkeyatts,
      key_detail.key_names,
      key_detail.key_options,
      regexp_replace(
        coalesce(pg_get_expr(index_metadata.indpred, index_metadata.indrelid), ''),
        '[()[:space:]]',
        '',
        'g'
      ) as predicate
    from pg_index as index_metadata
    join pg_class as index_relation on index_relation.oid = index_metadata.indexrelid
    join pg_class as table_relation on table_relation.oid = index_metadata.indrelid
    join pg_namespace as namespace on namespace.oid = table_relation.relnamespace
    join pg_am as access_method on access_method.oid = index_relation.relam
    left join lateral (
      select
        array_agg(attribute.attname order by key_column.ordinality) as key_names,
        array_agg(key_column.option order by key_column.ordinality)::smallint[] as key_options
      from unnest(
        index_metadata.indkey::smallint[],
        index_metadata.indoption::smallint[]
      ) with ordinality as key_column(attnum, option, ordinality)
      left join pg_attribute as attribute
        on attribute.attrelid = index_metadata.indrelid
       and attribute.attnum = key_column.attnum
      where key_column.ordinality <= index_metadata.indnkeyatts
    ) as key_detail on true
    where namespace.nspname = 'callora'
      and table_relation.relname = 'call_logs'
  )
  select string_agg(expected.index_name, ', ' order by expected.index_name)
    into invalid_indexes
  from expected
  left join actual using (index_name)
  where actual.index_name is null
    or actual.is_unique is distinct from expected.is_unique
    or actual.indisvalid is distinct from true
    or actual.indisready is distinct from true
    or actual.indislive is distinct from true
    or actual.access_method is distinct from 'btree'
    or actual.indnatts <> actual.indnkeyatts
    or actual.indnkeyatts <> cardinality(expected.key_names)
    or actual.key_names is distinct from expected.key_names
    or actual.key_options is distinct from expected.key_options
    or actual.predicate is distinct from expected.predicate;

  if invalid_indexes is not null then
    raise exception 'PII indexes are missing, invalid, unready, non-live, or structurally incorrect: %',
      invalid_indexes;
  end if;
  if to_regclass('callora.call_logs_phone_started_keyset_idx') is not null then
    raise exception 'legacy plaintext phone-number index still exists';
  end if;

  select constraint_definition.convalidated
    into representation_constraint_valid
  from pg_constraint as constraint_definition
  where constraint_definition.conrelid = 'callora.call_logs'::regclass
    and constraint_definition.conname = 'call_logs_pii_representation_valid'
    and constraint_definition.contype = 'c';
  if representation_constraint_valid is distinct from true then
    raise exception 'call_logs_pii_representation_valid is missing or not validated';
  end if;

  select string_agg(
      format(
        '%I.%I(%s)',
        namespace.nspname,
        function_definition.proname,
        pg_get_function_identity_arguments(function_definition.oid)
      ),
      E'\n'
      order by function_definition.oid
    )
    into public_security_definers
  from pg_proc as function_definition
  join pg_namespace as namespace
    on namespace.oid = function_definition.pronamespace
  where namespace.nspname = 'callora'
    and function_definition.prosecdef
    and exists (
      select 1
      from aclexplode(
        coalesce(
          function_definition.proacl,
          acldefault('f', function_definition.proowner)
        )
      ) as function_acl
      where function_acl.grantee = 0
        and function_acl.privilege_type = 'EXECUTE'
    );

  if public_security_definers is not null then
    raise exception 'Callora SECURITY DEFINER functions remain executable by PUBLIC: %',
      public_security_definers;
  end if;

  with expected(signature) as (
    values
      ('callora.upsert_mobile_call_encrypted(uuid,uuid,uuid,uuid,text,text,text,bytea,bytea,bytea,smallint,integer,timestamptz,timestamptz,integer,uuid,uuid,text,bytea,bytea,bytea,timestamptz,timestamptz,integer,boolean,boolean,text,timestamptz)'),
      ('callora.upsert_mobile_call_encrypted(uuid,uuid,uuid,uuid,text,text,text,bytea,bytea,bytea,smallint,integer,integer,timestamptz,timestamptz,integer,uuid,uuid,text,bytea,bytea,bytea,timestamptz,timestamptz,integer,boolean,boolean,text,timestamptz)'),
      ('callora.insert_manual_call_encrypted(uuid,uuid,uuid,uuid,text,text,text,smallint,integer,bytea,bytea,bytea,bytea,bytea,bytea,timestamptz,boolean,timestamptz,timestamptz,timestamptz,integer,integer,boolean,text,timestamptz)'),
      ('callora.insert_manual_call_encrypted(uuid,uuid,uuid,uuid,text,text,text,smallint,integer,integer,bytea,bytea,bytea,bytea,bytea,bytea,timestamptz,boolean,timestamptz,timestamptz,timestamptz,integer,integer,boolean,text,timestamptz)'),
      ('callora.backfill_call_pii_encrypted(uuid,uuid,smallint,integer,bytea,bytea,bytea,bytea,bytea,bytea,timestamptz)'),
      ('callora.backfill_call_pii_encrypted(uuid,uuid,smallint,integer,integer,bytea,bytea,bytea,bytea,bytea,bytea,timestamptz)'),
      ('callora.claim_call_pii_backfill_batch(uuid,integer)'),
      ('callora.claim_call_pii_rotation_batch(uuid,smallint,integer,integer,integer)'),
      ('callora.rotate_call_pii_encrypted(uuid,uuid,smallint,integer,integer,smallint,integer,integer,bytea,bytea,bytea,bytea,bytea,bytea,timestamptz)')
  ),
  resolved as (
    select signature, to_regprocedure(signature)::oid as function_oid
    from expected
  )
  select string_agg(resolved.signature, E'\n' order by resolved.signature)
    into invalid_functions
  from resolved
  left join pg_proc as function_definition on function_definition.oid = resolved.function_oid
  left join pg_roles as owner_role on owner_role.oid = function_definition.proowner
  where resolved.function_oid is null
    or function_definition.prosecdef is distinct from true
    or owner_role.rolname is distinct from 'callora_call_writer'
    or not coalesce(function_definition.proconfig, array[]::text[])
      @> array['search_path=pg_catalog']::text[]
    or exists (
      select 1
      from aclexplode(
        coalesce(
          function_definition.proacl,
          acldefault('f', function_definition.proowner)
        )
      ) as function_acl
      where function_acl.grantee = 0
        and function_acl.privilege_type = 'EXECUTE'
    );

  if invalid_functions is not null then
    raise exception 'encrypted write functions are missing or violate SECURITY DEFINER/owner/search_path/PUBLIC EXECUTE requirements: %',
      invalid_functions;
  end if;
end
$phase3d_pii_catalog$;

select 'Callora Phase 3D PII catalog verification passed.' as result;
