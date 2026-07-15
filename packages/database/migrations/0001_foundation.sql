-- Callora database foundation. PostgreSQL 15+ is the supported baseline.
create extension if not exists pgcrypto;

create schema if not exists callora;
revoke all on schema callora from public;

comment on schema callora is
  'Tenant-isolated operational data for the Callora call analytics platform.';

create table if not exists callora.schema_migrations (
  version text primary key,
  checksum_sha256 text not null,
  applied_at timestamptz not null default clock_timestamp(),
  constraint schema_migrations_version_not_blank check (btrim(version) <> ''),
  constraint schema_migrations_checksum_sha256_format
    check (checksum_sha256 ~ '^[0-9a-f]{64}$')
);

revoke all on table callora.schema_migrations from public;

create or replace function callora.current_organization_id()
returns uuid
language sql
stable
parallel safe
security invoker
set search_path = pg_catalog
as $$
  select nullif(current_setting('app.current_organization_id', true), '')::uuid
$$;

create or replace function callora.current_user_id()
returns uuid
language sql
stable
parallel safe
security invoker
set search_path = pg_catalog
as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

create or replace function callora.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end
$$;

revoke execute on function callora.current_organization_id() from public;
revoke execute on function callora.current_user_id() from public;
revoke execute on function callora.touch_updated_at() from public;
