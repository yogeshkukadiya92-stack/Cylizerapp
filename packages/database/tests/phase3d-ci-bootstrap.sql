\set ON_ERROR_STOP on
\getenv runtime_password PHASE3D_RUNTIME_PASSWORD
\getenv migration_password PHASE3D_MIGRATION_PASSWORD

select format(
  'create role callora_phase3d_migration login nosuperuser nocreatedb createrole inherit noreplication nobypassrls password %L',
  :'migration_password'
)
where not exists (select 1 from pg_roles where rolname = 'callora_phase3d_migration')
\gexec

select format(
  'create role callora_phase3d_runtime login nosuperuser nocreatedb nocreaterole inherit nobypassrls password %L',
  :'runtime_password'
)
where not exists (select 1 from pg_roles where rolname = 'callora_phase3d_runtime')
\gexec

create database callora_phase3d owner callora_phase3d_migration;
create database callora_phase3d_restore owner callora_phase3d_migration;
