import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { packageRoot } from "../scripts/schema-contract.mjs";

test("production-scale PII indexes use an idempotent non-transactional transition", () => {
  const migration = readFileSync(
    `${packageRoot}/migrations/0013_call_log_pii_concurrent_indexes.sql`,
    "utf8",
  );
  const runner = readFileSync(`${packageRoot}/scripts/run-sql.mjs`, "utf8");

  assert.match(migration, /^-- callora:migration-mode nontransactional/m);
  assert.match(migration, /set lock_timeout = '5s'/i);
  assert.match(migration, /set statement_timeout = '30min'/i);
  assert.match(migration, /drop index concurrently if exists callora\.call_logs_phone_started_keyset_idx/i);
  assert.equal((migration.match(/create (?:unique )?index concurrently/gi) ?? []).length, 4);
  assert.equal((migration.match(/drop index concurrently if exists/gi) ?? []).length, 5);
  assert.match(
    migration,
    /organization_id, pii_blind_index_key_version,\s*phone_number_blind_index, started_at desc, id desc/i,
  );
  assert.match(
    migration,
    /organization_id, pii_blind_index_key_version,\s*contact_name_blind_index, started_at desc, id desc/i,
  );
  assert.match(migration, /validate constraint call_logs_pii_representation_valid/i);

  assert.match(runner, /isNonTransactionalMigration\(migrationSql\)/);
  assert.match(runner, /pg_advisory_lock\(hashtextextended\('callora\.schema_migrations'/i);
  assert.match(runner, /pg_advisory_unlock\(hashtextextended\('callora\.schema_migrations'/i);
});
