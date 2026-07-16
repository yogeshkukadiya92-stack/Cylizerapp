-- Fix production mobile enrollment and session transitions.
--
-- prepare_device_credential_request returns a column named lifecycle_state.
-- PL/pgSQL exposes RETURNS TABLE columns as variables, so unqualified
-- lifecycle_state references inside UPDATE statements were ambiguous and
-- caused every pairing redemption to roll back. This migration recompiles the
-- function for both existing installations and fresh migration runs.

begin;

do $migration$
declare
  v_signature regprocedure :=
    'callora.prepare_device_credential_request(uuid,uuid,uuid,uuid,text,bytea,uuid,bytea,timestamp with time zone,uuid,uuid,timestamp with time zone)'::regprocedure;
  v_definition text;
  v_patched_definition text;
begin
  select pg_get_functiondef(v_signature) into v_definition;

  if position('#variable_conflict use_column' in v_definition) > 0 then
    return;
  end if;

  v_patched_definition := replace(
    v_definition,
    E'AS $function$\n',
    E'AS $function$\n#variable_conflict use_column\n'
  );

  if v_patched_definition = v_definition then
    raise exception 'Could not patch prepare_device_credential_request variable conflict policy';
  end if;

  execute v_patched_definition;
end
$migration$;

commit;
