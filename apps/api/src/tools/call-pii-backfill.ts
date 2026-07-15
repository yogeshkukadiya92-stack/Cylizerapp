import { timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  CALL_PII_FORMAT_VERSION,
  CallPiiCrypto,
  type EncryptedCallPiiField,
  parseCallPiiKeyring,
} from "../call-pii-crypto.js";
import { createPostgresPool } from "../postgres/pool.js";
import {
  assertPostgresConnectionStringHasNoSslOverrides,
  postgresSslOptions,
} from "../postgres/tls.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LegacyCallPiiRow {
  id: string;
  organization_id: string;
  phone_number: string;
  contact_name: string | null;
}

interface EncryptedCallPiiRow {
  id: string;
  organization_id: string;
  pii_encryption_version: number;
  pii_key_version: number;
  pii_blind_index_key_version: number;
  phone_number_ciphertext: Buffer;
  phone_number_nonce: Buffer;
  phone_number_blind_index: Buffer;
  contact_name_ciphertext: Buffer | null;
  contact_name_nonce: Buffer | null;
  contact_name_blind_index: Buffer | null;
}

type Mode = "backfill" | "rotate" | "verify";

interface MigratorRoleEvidence {
  rolcanlogin: boolean;
  rolinherit: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  is_pii_migrator: boolean;
  has_admin_role_membership: boolean;
  has_unexpected_role_membership: boolean;
  has_unsafe_login_high_impact_membership: boolean;
  high_impact_roles_are_safe: boolean;
  can_insert_call_logs: boolean;
  can_update_call_logs: boolean;
  can_delete_call_logs: boolean;
  can_truncate_call_logs: boolean;
  can_insert_any_call_log_column: boolean;
  can_update_any_call_log_column: boolean;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required; no call-log PII defaults are permitted`);
  }
  return value;
}

function organizationIdFromEnvironment(): string {
  const value = requiredEnvironment("CALL_PII_BACKFILL_ORGANIZATION_ID");
  if (!UUID_PATTERN.test(value)) {
    throw new Error("CALL_PII_BACKFILL_ORGANIZATION_ID must be a canonical UUID");
  }
  return value.toLowerCase();
}

function batchSizeFromEnvironment(): number {
  const serialized = process.env.CALL_PII_BACKFILL_BATCH_SIZE ?? "100";
  if (!/^[1-9][0-9]{0,2}$/.test(serialized)) {
    throw new Error("CALL_PII_BACKFILL_BATCH_SIZE must be an integer between 1 and 500");
  }
  const value = Number(serialized);
  if (value > 500) throw new Error("CALL_PII_BACKFILL_BATCH_SIZE must be an integer between 1 and 500");
  return value;
}

function cryptoFromEnvironment(): CallPiiCrypto {
  return new CallPiiCrypto(parseCallPiiKeyring({
    encryptionKeys: process.env.CALL_PII_ENCRYPTION_KEYS,
    activeKeyVersion: process.env.CALL_PII_ACTIVE_KEY_VERSION,
    rowIdKey: process.env.CALL_PII_ROW_ID_KEY,
    blindIndexKeys: process.env.CALL_PII_BLIND_INDEX_KEYS,
    activeBlindIndexKeyVersion: process.env.CALL_PII_ACTIVE_BLIND_INDEX_KEY_VERSION,
  }));
}

function modeFromArguments(): Mode {
  const mode = process.argv[2];
  if (mode !== "backfill" && mode !== "rotate" && mode !== "verify") {
    throw new Error("Usage: tsx src/tools/call-pii-backfill.ts <backfill|rotate|verify>");
  }
  return mode;
}

async function assertDedicatedMigratorRole(pool: Pool): Promise<void> {
  const result = await pool.query<MigratorRoleEvidence>(`
    select
      role.rolcanlogin,
      role.rolinherit,
      role.rolsuper,
      role.rolcreatedb,
      role.rolcreaterole,
      role.rolreplication,
      role.rolbypassrls,
      exists (
        with recursive current_capabilities(roleid) as (
          select membership.roleid
          from pg_catalog.pg_auth_members as membership
          where membership.member = role.oid
            and (
              current_setting('server_version_num')::integer < 160000
              or coalesce((to_jsonb(membership)->>'inherit_option')::boolean, false)
              or coalesce((to_jsonb(membership)->>'set_option')::boolean, false)
            )
          union
          select membership.roleid
          from current_capabilities as inherited
          join pg_catalog.pg_auth_members as membership
            on membership.member = inherited.roleid
          where current_setting('server_version_num')::integer < 160000
            or coalesce((to_jsonb(membership)->>'inherit_option')::boolean, false)
            or coalesce((to_jsonb(membership)->>'set_option')::boolean, false)
        )
        select 1
        from current_capabilities as capability
        join pg_catalog.pg_roles as capability_role
          on capability_role.oid = capability.roleid
        where capability_role.rolname = 'callora_pii_migrator'
      ) as is_pii_migrator,
      exists (
        select 1
        from pg_catalog.pg_auth_members as membership
        where membership.member = role.oid
          and coalesce((to_jsonb(membership)->>'admin_option')::boolean, false)
      ) as has_admin_role_membership,
      exists (
        select 1
        from pg_catalog.pg_roles as candidate
        where candidate.oid <> role.oid
          and candidate.rolname <> 'callora_pii_migrator'
          and pg_has_role(current_user, candidate.oid, 'member')
      ) as has_unexpected_role_membership,
      exists (
        with recursive membership_closure(login_oid, roleid) as (
          select login_role.oid, membership.roleid
          from pg_catalog.pg_roles as login_role
          join pg_catalog.pg_auth_members as membership
            on membership.member = login_role.oid
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
        join pg_catalog.pg_roles as high_impact_role
          on high_impact_role.rolname in ('callora_call_writer', 'callora_pii_migrator')
        join membership_closure as inherited
          on inherited.login_oid = login_role.oid
         and inherited.roleid = high_impact_role.oid
        where login_role.rolcanlogin
          and not (
            login_role.oid = role.oid
            and high_impact_role.rolname = 'callora_pii_migrator'
          )
      ) as has_unsafe_login_high_impact_membership,
      not exists (
        select 1
        from (values
          ('callora_call_writer'),
          ('callora_pii_migrator')
        ) as expected(role_name)
        left join pg_catalog.pg_roles as high_impact_role
          on high_impact_role.rolname = expected.role_name
        where high_impact_role.oid is null
          or high_impact_role.rolcanlogin
          or high_impact_role.rolinherit
          or high_impact_role.rolsuper
          or high_impact_role.rolcreatedb
          or high_impact_role.rolcreaterole
          or high_impact_role.rolreplication
          or high_impact_role.rolbypassrls
      ) as high_impact_roles_are_safe,
      has_table_privilege(current_user, 'callora.call_logs', 'INSERT') as can_insert_call_logs,
      has_table_privilege(current_user, 'callora.call_logs', 'UPDATE') as can_update_call_logs,
      has_table_privilege(current_user, 'callora.call_logs', 'DELETE') as can_delete_call_logs,
      has_table_privilege(current_user, 'callora.call_logs', 'TRUNCATE') as can_truncate_call_logs,
      has_any_column_privilege(current_user, 'callora.call_logs', 'INSERT') as can_insert_any_call_log_column,
      has_any_column_privilege(current_user, 'callora.call_logs', 'UPDATE') as can_update_any_call_log_column
    from pg_catalog.pg_roles as role
    where role.rolname = current_user
  `);
  const evidence = result.rows[0];
  if (!evidence || !evidence.rolcanlogin || !evidence.rolinherit || evidence.rolsuper || evidence.rolcreatedb ||
    evidence.rolcreaterole || evidence.rolreplication || evidence.rolbypassrls ||
    !evidence.is_pii_migrator || evidence.has_admin_role_membership || evidence.has_unexpected_role_membership ||
    evidence.has_unsafe_login_high_impact_membership || !evidence.high_impact_roles_are_safe ||
    evidence.can_insert_call_logs || evidence.can_update_call_logs || evidence.can_delete_call_logs ||
    evidence.can_truncate_call_logs ||
    evidence.can_insert_any_call_log_column || evidence.can_update_any_call_log_column) {
    throw new Error(
      "PII backfill requires safe NOLOGIN writer/migrator roles, no competing high-impact capability LOGIN, no other roles, and no direct call_logs writes or TRUNCATE",
    );
  }
}

async function beginTenantTransaction(client: PoolClient, organizationId: string): Promise<void> {
  await client.query("begin");
  await client.query("set local lock_timeout = '5s'");
  await client.query("set local statement_timeout = '30s'");
  await client.query(
    "select set_config('app.current_organization_id', $1, true)",
    [organizationId],
  );
}

async function backfillBatch(
  pool: Pool,
  crypto: CallPiiCrypto,
  organizationId: string,
  batchSize: number,
): Promise<number> {
  const client = await pool.connect();
  try {
    await beginTenantTransaction(client, organizationId);
    const selected = await client.query<LegacyCallPiiRow>(`
      select id, organization_id, phone_number, contact_name
      from callora.claim_call_pii_backfill_batch($1::uuid, $2::integer)
    `, [organizationId, batchSize]);

    for (const row of selected.rows) {
      if (!UUID_PATTERN.test(row.id) || row.organization_id.toLowerCase() !== organizationId ||
        typeof row.phone_number !== "string" || typeof row.contact_name !== "string" && row.contact_name !== null) {
        throw new Error("Legacy call-log PII row has an invalid shape");
      }
      const phone = crypto.encryptField({
        organizationId,
        rowId: row.id,
        field: "phone_number",
      }, row.phone_number);
      const contact = row.contact_name === null ? null : crypto.encryptField({
        organizationId,
        rowId: row.id,
        field: "contact_name",
      }, row.contact_name);
      const updated = await client.query<{ transitioned: boolean }>(`
        select callora.backfill_call_pii_encrypted(
          $1::uuid, $2::uuid, $3::smallint, $4::integer, $5::integer,
          $6::bytea, $7::bytea, $8::bytea, $9::bytea, $10::bytea,
          $11::bytea, clock_timestamp()
        ) as transitioned
      `, [
        organizationId,
        row.id,
        phone.formatVersion,
        phone.keyVersion,
        phone.blindIndexKeyVersion,
        phone.ciphertext,
        phone.nonce,
        phone.blindIndex,
        contact?.ciphertext ?? null,
        contact?.nonce ?? null,
        contact?.blindIndex ?? null,
      ]);
      if (updated.rows[0]?.transitioned !== true) {
        throw new Error("Locked call-log PII row changed before encryption");
      }
    }
    await client.query("commit");
    return selected.rowCount ?? 0;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function encryptedField(
  row: EncryptedCallPiiRow,
  field: "phone_number" | "contact_name",
): EncryptedCallPiiField | null {
  const ciphertext = field === "phone_number" ? row.phone_number_ciphertext : row.contact_name_ciphertext;
  const nonce = field === "phone_number" ? row.phone_number_nonce : row.contact_name_nonce;
  const blindIndex = field === "phone_number" ? row.phone_number_blind_index : row.contact_name_blind_index;
  if (ciphertext === null && nonce === null && blindIndex === null && field === "contact_name") return null;
  if (!Buffer.isBuffer(ciphertext) || !Buffer.isBuffer(nonce) || !Buffer.isBuffer(blindIndex)) {
    throw new Error("Encrypted call-log PII row has an incomplete envelope");
  }
  return {
    formatVersion: row.pii_encryption_version,
    keyVersion: row.pii_key_version,
    blindIndexKeyVersion: row.pii_blind_index_key_version,
    ciphertext,
    nonce,
    blindIndex,
  };
}

function blindIndexMatches(expected: Buffer, actual: Buffer): boolean {
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function rotateBatch(
  pool: Pool,
  crypto: CallPiiCrypto,
  organizationId: string,
  batchSize: number,
): Promise<number> {
  const client = await pool.connect();
  try {
    await beginTenantTransaction(client, organizationId);
    const selected = await client.query<EncryptedCallPiiRow>(`
      select *
      from callora.claim_call_pii_rotation_batch(
        $1::uuid, $2::smallint, $3::integer, $4::integer, $5::integer
      )
    `, [
      organizationId,
      CALL_PII_FORMAT_VERSION,
      crypto.activeEncryptionKeyVersion,
      crypto.activeBlindIndexKeyVersion,
      batchSize,
    ]);

    for (const row of selected.rows) {
      if (!UUID_PATTERN.test(row.id) || row.organization_id.toLowerCase() !== organizationId ||
        !Number.isSafeInteger(row.pii_encryption_version) || !Number.isSafeInteger(row.pii_key_version) ||
        !Number.isSafeInteger(row.pii_blind_index_key_version)) {
        throw new Error("Encrypted call-log PII rotation row has an invalid shape");
      }
      const phoneEnvelope = encryptedField(row, "phone_number");
      if (phoneEnvelope === null) throw new Error("Encrypted call-log PII row is missing phone data");
      const phoneContext = { organizationId, rowId: row.id, field: "phone_number" as const };
      const phone = crypto.encryptField(phoneContext, crypto.decryptField(phoneContext, phoneEnvelope));
      const contactEnvelope = encryptedField(row, "contact_name");
      const contactContext = { organizationId, rowId: row.id, field: "contact_name" as const };
      const contact = contactEnvelope === null
        ? null
        : crypto.encryptField(contactContext, crypto.decryptField(contactContext, contactEnvelope));
      if (contact !== null && (contact.keyVersion !== phone.keyVersion ||
        contact.blindIndexKeyVersion !== phone.blindIndexKeyVersion ||
        contact.formatVersion !== phone.formatVersion)) {
        throw new Error("Call-log PII fields were encrypted with mixed active keys");
      }

      const rotated = await client.query<{ rotated: boolean }>(`
        select callora.rotate_call_pii_encrypted(
          $1::uuid, $2::uuid, $3::smallint, $4::integer, $5::integer,
          $6::smallint, $7::integer, $8::integer,
          $9::bytea, $10::bytea, $11::bytea, $12::bytea, $13::bytea,
          $14::bytea, clock_timestamp()
        ) as rotated
      `, [
        organizationId,
        row.id,
        row.pii_encryption_version,
        row.pii_key_version,
        row.pii_blind_index_key_version,
        phone.formatVersion,
        phone.keyVersion,
        phone.blindIndexKeyVersion,
        phone.ciphertext,
        phone.nonce,
        phone.blindIndex,
        contact?.ciphertext ?? null,
        contact?.nonce ?? null,
        contact?.blindIndex ?? null,
      ]);
      if (rotated.rows[0]?.rotated !== true) {
        throw new Error("Locked call-log PII row changed before key rotation");
      }
    }
    await client.query("commit");
    return selected.rowCount ?? 0;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function verifyEncryptedRows(
  pool: Pool,
  crypto: CallPiiCrypto,
  organizationId: string,
  batchSize: number,
  requireActiveVersions: boolean,
): Promise<number> {
  let verified = 0;
  let afterId: string | null = null;

  while (true) {
    const client = await pool.connect();
    let rows: EncryptedCallPiiRow[];
    try {
      await beginTenantTransaction(client, organizationId);
      const legacy = await client.query<{ count: string }>(`
        select count(*)::text as count
        from callora.call_logs
        where organization_id = $1::uuid
          and (phone_number is not null or contact_name is not null)
      `, [organizationId]);
      if (Number(legacy.rows[0]?.count ?? "0") !== 0) {
        throw new Error("Plaintext call-log PII remains for this organization");
      }
      const selected = await client.query<EncryptedCallPiiRow>(`
        select
          id, organization_id, pii_encryption_version, pii_key_version,
          pii_blind_index_key_version,
          phone_number_ciphertext, phone_number_nonce, phone_number_blind_index,
          contact_name_ciphertext, contact_name_nonce, contact_name_blind_index
        from callora.call_logs
        where organization_id = $1::uuid
          and pii_encryption_version is not null
          and ($2::uuid is null or id > $2::uuid)
        order by id
        limit $3
      `, [organizationId, afterId, batchSize]);
      rows = selected.rows;
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    for (const row of rows) {
      if (!UUID_PATTERN.test(row.id) || row.organization_id.toLowerCase() !== organizationId ||
        !Number.isSafeInteger(row.pii_encryption_version) || !Number.isSafeInteger(row.pii_key_version) ||
        !Number.isSafeInteger(row.pii_blind_index_key_version)) {
        throw new Error("Encrypted call-log PII row has an invalid shape");
      }
      if (requireActiveVersions && (row.pii_encryption_version !== CALL_PII_FORMAT_VERSION ||
        row.pii_key_version !== crypto.activeEncryptionKeyVersion ||
        row.pii_blind_index_key_version !== crypto.activeBlindIndexKeyVersion)) {
        throw new Error("Encrypted call-log PII row still uses a retired key version");
      }
      for (const field of ["phone_number", "contact_name"] as const) {
        const envelope = encryptedField(row, field);
        if (envelope === null) continue;
        const context = { organizationId, rowId: row.id, field };
        const plaintext = crypto.decryptField(context, envelope);
        const expectedIndex = crypto.computeBlindIndex(
          { organizationId, field },
          plaintext,
          envelope.blindIndexKeyVersion,
        );
        if (!blindIndexMatches(expectedIndex, envelope.blindIndex)) {
          throw new Error("Encrypted call-log PII blind index verification failed");
        }
      }
    }
    verified += rows.length;
    if (rows.length < batchSize) return verified;
    afterId = rows.at(-1)?.id ?? null;
  }
}

async function main(): Promise<void> {
  const mode = modeFromArguments();
  const organizationId = organizationIdFromEnvironment();
  const batchSize = batchSizeFromEnvironment();
  const crypto = cryptoFromEnvironment();
  const connectionString = requiredEnvironment("DATABASE_URL");
  assertPostgresConnectionStringHasNoSslOverrides(connectionString);
  const pool = createPostgresPool({
    connectionString,
    max: 2,
    ssl: postgresSslOptions(requiredEnvironment("DATABASE_SSL_MODE"), { requireVerified: true }),
    applicationName: "callora-call-pii-backfill",
  });
  try {
    await assertDedicatedMigratorRole(pool);
    let encryptedRows = 0;
    let rotatedRows = 0;
    if (mode === "backfill") {
      while (true) {
        const count = await backfillBatch(pool, crypto, organizationId, batchSize);
        encryptedRows += count;
        if (count < batchSize) break;
      }
    }
    if (mode === "rotate") {
      while (true) {
        const count = await rotateBatch(pool, crypto, organizationId, batchSize);
        rotatedRows += count;
        if (count < batchSize) break;
      }
    }
    const verifiedRows = await verifyEncryptedRows(
      pool,
      crypto,
      organizationId,
      batchSize,
      mode === "rotate",
    );
    console.log(JSON.stringify({ mode, organizationId, encryptedRows, rotatedRows, verifiedRows }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown call-log PII migration failure";
  console.error(message);
  process.exitCode = 1;
});
