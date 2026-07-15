-- Create the NOLOGIN group roles referenced by later migrations. Full grants
-- and hardening are applied by access/roles.sql after all migrations finish.
begin;

do $$
declare
  role_name text;
begin
  foreach role_name in array array[
    'callora_api',
    'callora_ingest',
    'callora_auditor',
    'callora_worker',
    'callora_call_writer',
    'callora_pii_migrator'
  ]
  loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format(
        'create role %I nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls',
        role_name
      );
    end if;
  end loop;
end
$$;

commit;
