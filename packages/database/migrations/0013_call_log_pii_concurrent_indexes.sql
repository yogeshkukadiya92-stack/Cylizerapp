-- callora:migration-mode nontransactional
--
-- This migration must stay idempotent: the migration runner cannot atomically
-- wrap CREATE/DROP INDEX CONCURRENTLY with its checksum ledger. If a command or
-- the ledger insert fails, a retry first removes any partial/invalid target
-- indexes and builds them again before recording the migration.

set lock_timeout = '5s';
set statement_timeout = '30min';

drop index concurrently if exists callora.call_logs_phone_nonce_unique;
create unique index concurrently call_logs_phone_nonce_unique
  on callora.call_logs (pii_key_version, phone_number_nonce)
  where phone_number_nonce is not null;

drop index concurrently if exists callora.call_logs_contact_nonce_unique;
create unique index concurrently call_logs_contact_nonce_unique
  on callora.call_logs (pii_key_version, contact_name_nonce)
  where contact_name_nonce is not null;

drop index concurrently if exists callora.call_logs_phone_blind_started_keyset_idx;
create index concurrently call_logs_phone_blind_started_keyset_idx
  on callora.call_logs (
    organization_id, pii_blind_index_key_version,
    phone_number_blind_index, started_at desc, id desc
  )
  where phone_number_blind_index is not null;

drop index concurrently if exists callora.call_logs_contact_blind_started_keyset_idx;
create index concurrently call_logs_contact_blind_started_keyset_idx
  on callora.call_logs (
    organization_id, pii_blind_index_key_version,
    contact_name_blind_index, started_at desc, id desc
  )
  where contact_name_blind_index is not null;

drop index concurrently if exists callora.call_logs_phone_started_keyset_idx;

-- NOT VALID made the expand step short. Validation scans existing rows while
-- taking a weaker lock than adding a fully validated CHECK in the ALTER step.
alter table callora.call_logs
  validate constraint call_logs_pii_representation_valid;

analyze callora.call_logs;
