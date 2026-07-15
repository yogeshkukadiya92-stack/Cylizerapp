import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { CallPiiCrypto, parseCallPiiKeyring } from "../../src/call-pii-crypto.js";
import {
  PostgresCalloraRepository,
  UuidIdGenerator,
} from "../../src/postgres/repository.js";
import type { PgClientLike, PgPoolLike } from "../../src/postgres/types.js";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000101";
const ROLE_ID = "10000000-0000-4000-8000-000000000201";
const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000501";
const CURSOR_EMPLOYEE_ID = "10000000-0000-4000-8000-000000000502";
const TEAM_ID = "10000000-0000-4000-8000-000000000401";
const PAIRING_ID = "10000000-0000-4000-8000-000000000801";
const CALL_ID = "10000000-0000-4000-8000-000000000a01";
const DEVICE_ID = "10000000-0000-4000-8000-000000000601";
const CREDENTIAL_ID = "10000000-0000-4000-8000-000000000901";
const NEW_CREDENTIAL_ID = "10000000-0000-4000-8000-000000000902";
const REQUEST_ID = "10000000-0000-4000-8000-000000000903";
const AUDIT_ID = "10000000-0000-4000-8000-000000000904";
const OUTBOX_ID = "10000000-0000-4000-8000-000000000905";
const POLICY_ID = "30000000-0000-4000-8000-000000000002";
const POLICY_HASH = "a".repeat(64);
const INGEST_BATCH_ID = "10000000-0000-4000-8000-000000000b01";
const TIMESTAMP = "2026-07-15T08:00:00.000Z";

function testCallPiiCrypto(): CallPiiCrypto {
  return new CallPiiCrypto(parseCallPiiKeyring({
    encryptionKeys: `1:${Buffer.alloc(32, 1).toString("base64url")}`,
    activeKeyVersion: "1",
    rowIdKey: Buffer.alloc(32, 7).toString("base64url"),
    blindIndexKeys: `1:${Buffer.alloc(32, 9).toString("base64url")}`,
    activeBlindIndexKeyVersion: "1",
  }));
}

interface QueryCall {
  text: string;
  values: unknown[];
}

type Script = (call: QueryCall) => QueryResultRow[] | Promise<QueryResultRow[]>;

function queryResult<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

class ScriptedClient implements PgClientLike {
  readonly calls: QueryCall[] = [];
  released = false;

  constructor(private readonly script: Script) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const call = { text, values };
    this.calls.push(call);
    const rows = await this.script(call);
    return queryResult(rows as Row[]);
  }

  release(): void {
    this.released = true;
  }
}

class ScriptedPool implements PgPoolLike {
  readonly directCalls: QueryCall[] = [];
  connectCount = 0;
  ended = false;

  constructor(
    readonly client: ScriptedClient,
    private readonly directScript: Script = () => [],
  ) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const call = { text, values };
    this.directCalls.push(call);
    const rows = await this.directScript(call);
    return queryResult(rows as Row[]);
  }

  async connect(): Promise<PgClientLike> {
    this.connectCount += 1;
    return this.client;
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function actorRow(): QueryResultRow {
  return {
    organization_id: ORGANIZATION_ID,
    organization_name: "Aster Sales Labs",
    organization_slug: "aster-sales-labs",
    organization_status: "active",
    organization_plan: "growth",
    time_zone: "Asia/Kolkata",
    default_country_code: "+91",
    working_week_days: [1, 2, 3, 4, 5, 6],
    working_day_starts_at: "09:00:00",
    working_day_ends_at: "18:00:00",
    recording_retention_days: 90,
    call_log_retention_days: 730,
    require_recording_consent: true,
    mask_phone_numbers_for_restricted_users: true,
    organization_created_at: TIMESTAMP,
    organization_updated_at: TIMESTAMP,
    user_id: USER_ID,
    user_email: "owner@aster.test",
    user_display_name: "Aarav Shah",
    user_status: "active",
    user_created_at: TIMESTAMP,
    user_updated_at: TIMESTAMP,
  };
}

function roleRow(): QueryResultRow {
  return {
    id: ROLE_ID,
    organization_id: ORGANIZATION_ID,
    name: "Owner",
    system_key: "owner",
    is_editable: false,
    permissions: ["organization.read", "employees.read"],
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  };
}

function adminRoleRow(): QueryResultRow {
  return {
    ...roleRow(),
    id: "10000000-0000-4000-8000-000000000202",
    name: "Admin",
    system_key: "admin",
  };
}

function employeeRow(id = EMPLOYEE_ID, name = "Aarav Shah"): QueryResultRow {
  return {
    id,
    organization_id: ORGANIZATION_ID,
    display_name: name,
    status: "active",
    team_name: "Inside Sales",
    device_ids: [],
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  };
}

function deviceRow(status = "connected"): QueryResultRow {
  return {
    id: DEVICE_ID,
    organization_id: ORGANIZATION_ID,
    employee_id: EMPLOYEE_ID,
    installation_id: "android-installation-1",
    platform: "android",
    os_version: "16",
    app_version: "0.1.0",
    status,
    sync_state: "idle",
    call_log_permission: "granted",
    phone_state_permission: "granted",
    contacts_permission: "denied",
    notifications_permission: "granted",
    recording_files_permission: "unknown",
    background_execution_permission: "granted",
    sim_cards: [],
    registered_at: TIMESTAMP,
    last_seen_at: TIMESTAMP,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  };
}

function policyRow(
  id = POLICY_ID,
  contentHash = POLICY_HASH,
): QueryResultRow {
  return {
    id,
    policy_version: "2026.1-enterprise-call-metadata",
    disclosure_version: "2026.1-enterprise-disclosure",
    collection_mode: "android_call_log",
    purpose: "call_metadata",
    title: "Callora enterprise call metadata",
    summary: "Authoritative disclosure",
    disclosures: ["Metadata only"],
    content_hash: contentHash,
    effective_at: TIMESTAMP,
  };
}

function mobilePolicy() {
  return {
    id: POLICY_ID,
    contentHash: POLICY_HASH,
    policyVersion: "2026.1-enterprise-call-metadata",
    disclosureVersion: "2026.1-enterprise-disclosure",
    collectionMode: "android_call_log" as const,
    purpose: "call_metadata" as const,
    title: "Callora enterprise call metadata",
    summary: "Authoritative disclosure",
    disclosures: ["Metadata only"],
    effectiveAt: TIMESTAMP,
  };
}

function mobilePermissions() {
  return {
    callLog: "granted" as const,
    phoneState: "granted" as const,
    contacts: "denied" as const,
    notifications: "granted" as const,
    recordingFiles: "unknown" as const,
    backgroundExecution: "granted" as const,
  };
}

function mobileTrustRows(sql: string, consentCurrent = true): QueryResultRow[] | undefined {
  if (sql.startsWith("select linked_user_id, status from callora.employees")) {
    return [{ linked_user_id: USER_ID, status: "active" }];
  }
  if (sql.startsWith("select * from callora.employee_devices")) {
    return [{
      ...deviceRow(),
      collection_mode: "android_call_log",
      revoked_at: null,
    }];
  }
  if (sql.startsWith("select id, employee_id, credential_type")) return [{
    id: CREDENTIAL_ID,
    employee_id: EMPLOYEE_ID,
    credential_type: "session",
    lifecycle_state: "active",
    consumed_at: null,
    revoked_at: null,
    expires_at: "2026-07-22T08:00:00.000Z",
  }];
  if (sql.startsWith("select id from callora.device_consent_receipts")) return [{ id: "consent" }];
  if (sql.startsWith("select status from callora.organizations")) return [{ status: "active" }];
  if (sql.includes("callora.device_has_current_collection_consent")) return [{ consent_current: consentCurrent }];
  if (sql.includes("from callora.resolve_mobile_collection_policy")) return [{
    current_policy_id: POLICY_ID,
    current_policy_content_hash: POLICY_HASH,
  }];
  return undefined;
}

describe("PostgresCalloraRepository transaction and tenant boundaries", () => {
  it("sets transaction-local tenant/user context and commits an actor lookup", async () => {
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.includes("from callora.organizations as organization")) return [actorRow()];
      if (sql.includes("from callora.organization_memberships as membership") && sql.includes("array_agg")) {
        return [roleRow()];
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));

    const actor = await repository.findActor(ORGANIZATION_ID, USER_ID);

    expect(actor?.organization.id).toBe(ORGANIZATION_ID);
    expect(actor?.user.id).toBe(USER_ID);
    expect(actor?.roleKey).toBe("owner");
    expect(client.calls.map((call) => normalized(call.text))).toEqual([
      "begin",
      expect.stringContaining("set_config('statement_timeout', $1, true)"),
      expect.stringContaining("set_config('app.current_organization_id', $1, true)"),
      expect.stringContaining("from callora.organizations as organization"),
      expect.stringContaining("array_agg(role_permission.permission_key"),
      "commit",
    ]);
    expect(client.calls[2]?.values).toEqual([ORGANIZATION_ID, USER_ID]);
    expect(client.released).toBe(true);
  });

  it("rolls back and releases the connection when a tenant query fails", async () => {
    const client = new ScriptedClient(({ text }) => {
      if (normalized(text).includes("from callora.employees as employee")) {
        throw new Error("scripted database failure");
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));

    await expect(repository.listEmployees({
      organizationId: ORGANIZATION_ID,
      filter: {},
      limit: 25,
    })).rejects.toThrow("scripted database failure");

    expect(client.calls.map((call) => normalized(call.text))).toContain("rollback");
    expect(client.calls.map((call) => normalized(call.text))).not.toContain("commit");
    expect(client.released).toBe(true);
  });

  it("chooses the highest explicit system-role priority when memberships have multiple roles", async () => {
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.includes("from callora.organizations as organization")) return [actorRow()];
      if (sql.includes("array_agg(role_permission.permission_key")) return [adminRoleRow(), roleRow()];
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));

    const actor = await repository.findActor(ORGANIZATION_ID, USER_ID);

    expect(actor?.roles.map((role) => role.systemKey)).toEqual(["admin", "owner"]);
    expect(actor?.roleKey).toBe("owner");
  });

  it("uses a tenant-first employee keyset query and binds hostile search input", async () => {
    const client = new ScriptedClient(({ text }) =>
      normalized(text).includes("from callora.employees as employee")
        ? [employeeRow(EMPLOYEE_ID, "Mira"), employeeRow(CURSOR_EMPLOYEE_ID, "Zoya")]
        : []);
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));
    const hostileSearch = "%' or true; --";

    const page = await repository.listEmployees({
      organizationId: ORGANIZATION_ID,
      filter: { search: hostileSearch },
      after: { displayName: "Aarav", id: CURSOR_EMPLOYEE_ID },
      limit: 1,
    });

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    const query = client.calls.find((call) => normalized(call.text).includes("from callora.employees as employee"));
    expect(normalized(query?.text ?? "")).toContain("employee.organization_id = $1::uuid");
    expect(normalized(query?.text ?? "")).toContain("(lower(employee.display_name), employee.id) >");
    expect(query?.text).not.toContain(hostileSearch);
    expect(query?.values).toEqual([
      ORGANIZATION_ID,
      hostileSearch,
      "Aarav",
      CURSOR_EMPLOYEE_ID,
      2,
    ]);
  });

  it("binds call filters and applies descending composite keyset pagination", async () => {
    const client = new ScriptedClient(() => []);
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));

    await repository.listCalls({
      organizationId: ORGANIZATION_ID,
      filter: { employeeId: EMPLOYEE_ID, disposition: "missed", from: TIMESTAMP },
      after: { startedAt: "2026-07-15T07:00:00.000Z", id: CALL_ID },
      limit: 50,
    });

    const query = client.calls.find((call) => normalized(call.text).includes("from callora.call_logs as call_log"));
    expect(normalized(query?.text ?? "")).toContain("(call_log.started_at, call_log.id) <");
    expect(normalized(query?.text ?? "")).toContain("order by call_log.started_at desc, call_log.id desc");
    expect(query?.values).toEqual([
      ORGANIZATION_ID,
      EMPLOYEE_ID,
      "missed",
      TIMESTAMP,
      "2026-07-15T07:00:00.000Z",
      CALL_ID,
      51,
    ]);
  });

  it("returns an empty call page for a malformed employee id before opening a connection", async () => {
    const pool = new ScriptedPool(new ScriptedClient(() => []));
    const repository = new PostgresCalloraRepository(pool);

    await expect(repository.listCalls({
      organizationId: ORGANIZATION_ID,
      filter: { employeeId: "not-a-uuid" },
      limit: 50,
    })).resolves.toEqual({ items: [], hasMore: false });
    expect(pool.connectCount).toBe(0);
  });

  it("rejects a malformed OIDC organization claim without touching PostgreSQL", async () => {
    const client = new ScriptedClient(() => []);
    const pool = new ScriptedPool(client);
    const repository = new PostgresCalloraRepository(pool);

    await expect(repository.resolveActorByExternalIdentity({
      organizationId: "not-a-uuid",
      issuer: "https://identity.example.test",
      subject: "subject-1",
    })).resolves.toBeUndefined();
    expect(pool.connectCount).toBe(0);
    expect(pool.directCalls).toHaveLength(0);
  });

  it("matches all OIDC identity fields as parameters before loading the actor", async () => {
    const issuer = "https://identity.example.test";
    const subject = "oidc|owner-1";
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.includes("from callora.user_identities as identity")) return [{ user_id: USER_ID }];
      if (sql.includes("from callora.organizations as organization")) return [actorRow()];
      if (sql.includes("array_agg(role_permission.permission_key")) return [roleRow()];
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));

    const actor = await repository.resolveActorByExternalIdentity({
      organizationId: ORGANIZATION_ID,
      issuer,
      subject,
    });

    expect(actor?.user.id).toBe(USER_ID);
    const identityQuery = client.calls.find((call) => normalized(call.text).includes("from callora.user_identities as identity"));
    expect(identityQuery?.values).toEqual([ORGANIZATION_ID, issuer, subject]);
    expect(identityQuery?.text).not.toContain(issuer);
    expect(identityQuery?.text).not.toContain(subject);
  });

  it("writes the employee outbox row before committing the mutation", async () => {
    const newEmployeeId = "10000000-0000-4000-8000-000000000599";
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.startsWith("select id from callora.teams")) return [{ id: TEAM_ID }];
      if (sql.startsWith("insert into callora.employees")) return [{ id: newEmployeeId }];
      if (sql.includes("from callora.employees as employee")) return [employeeRow(newEmployeeId, "Nisha")];
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));

    const employee = await repository.createEmployee(
      ORGANIZATION_ID,
      { displayName: "Nisha", team: "Inside Sales" },
      USER_ID,
      TIMESTAMP,
    );

    expect(employee.id).toBe(newEmployeeId);
    const statements = client.calls.map((call) => normalized(call.text));
    expect(statements).toContain(
      "insert into callora.teams (organization_id, name) values ($1::uuid, $2) on conflict (organization_id, (lower(name))) do nothing",
    );
    const outboxIndex = statements.findIndex((sql) => sql.startsWith("insert into callora.outbox_events"));
    expect(outboxIndex).toBeGreaterThan(0);
    expect(statements.indexOf("commit")).toBeGreaterThan(outboxIndex);
  });

  it("maps known employee uniqueness violations to a stable 409 and rolls back", async () => {
    const client = new ScriptedClient(({ text }) => {
      if (normalized(text).startsWith("insert into callora.employees")) {
        throw Object.assign(new Error("duplicate key"), {
          code: "23505",
          constraint: "employees_organization_email_key",
        });
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));

    await expect(repository.createEmployee(
      ORGANIZATION_ID,
      { displayName: "Duplicate", email: "owner@aster.test" },
      USER_ID,
      TIMESTAMP,
    )).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
    expect(client.calls.map((call) => normalized(call.text))).toContain("rollback");
  });

  it("writes a revoke outbox event only when the pairing code changes state", async () => {
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.startsWith("update callora.device_pairing_codes")) {
        return [{ id: PAIRING_ID, employee_id: EMPLOYEE_ID }];
      }
      if (sql.includes("from callora.device_pairing_codes as pairing")) {
        return [{
          id: PAIRING_ID,
          organization_id: ORGANIZATION_ID,
          employee_id: EMPLOYEE_ID,
          code_hash: "a".repeat(64),
          code_hint: "A101",
          created_by_user_id: USER_ID,
          collection_mode: "android_call_log",
          expires_at: "2026-07-15T10:00:00.000Z",
          revoked_at: TIMESTAMP,
          created_at: "2026-07-15T07:00:00.000Z",
        }];
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));

    const pairing = await repository.revokePairingCode(ORGANIZATION_ID, PAIRING_ID, TIMESTAMP);

    expect(pairing?.revokedAt).toBe(TIMESTAMP);
    const outbox = client.calls.filter((call) => normalized(call.text).startsWith("insert into callora.outbox_events"));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.values).toEqual([
      ORGANIZATION_ID,
      "pairing_code",
      PAIRING_ID,
      "pairing_code.revoked",
      JSON.stringify({ pairingCodeId: PAIRING_ID, employeeId: EMPLOYEE_ID }),
    ]);
  });

  it("delegates administrator device revocation and exact replay to one atomic database transition", async () => {
    let transitionCount = 0;
    const responseBody = {
      requestId: REQUEST_ID,
      deviceId: DEVICE_ID,
      employeeId: EMPLOYEE_ID,
      revokedAt: TIMESTAMP,
      reason: "Lost corporate handset",
      revokedCredentialCount: 2,
      consentWithdrawn: true,
    };
    const client = new ScriptedClient(({ text }) => {
      if (normalized(text).includes("callora.admin_revoke_device")) {
        transitionCount += 1;
        return [{ response_body: responseBody, replayed: transitionCount > 1 }];
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));
    const options = {
      organizationId: ORGANIZATION_ID,
      deviceId: DEVICE_ID,
      actorUserId: USER_ID,
      requestId: REQUEST_ID,
      requestFingerprint: "f".repeat(64),
      reason: "Lost corporate handset",
      auditEventId: AUDIT_ID,
      outboxEventId: OUTBOX_ID,
      at: TIMESTAMP,
    };

    await expect(repository.revokeDeviceByAdministrator(options)).resolves.toMatchObject({
      deviceId: DEVICE_ID,
      employeeId: EMPLOYEE_ID,
      revokedAt: TIMESTAMP,
      reason: "Lost corporate handset",
      revokedCredentialCount: 2,
      consentWithdrawn: true,
      replayed: false,
    });
    await expect(repository.revokeDeviceByAdministrator(options)).resolves.toMatchObject({
      deviceId: DEVICE_ID,
      employeeId: EMPLOYEE_ID,
      revokedAt: TIMESTAMP,
      reason: "Lost corporate handset",
      revokedCredentialCount: 2,
      consentWithdrawn: true,
      replayed: true,
    });

    const transitions = client.calls.filter((call) =>
      normalized(call.text).includes("callora.admin_revoke_device"));
    expect(transitions).toHaveLength(2);
    expect(transitions[0]?.values).toEqual([
      REQUEST_ID,
      ORGANIZATION_ID,
      DEVICE_ID,
      USER_ID,
      AUDIT_ID,
      OUTBOX_ID,
      "f".repeat(64),
      "Lost corporate handset",
      TIMESTAMP,
    ]);
    const statements = client.calls.map((call) => normalized(call.text));
    expect(statements.some((sql) => sql.startsWith("update callora.device_credentials"))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("insert into callora.audit_events"))).toBe(false);
    expect(statements.filter((sql) => sql === "commit")).toHaveLength(2);
  });

  it("maps an administrator revocation request-id conflict to a stable 409", async () => {
    const client = new ScriptedClient(({ text }) => {
      if (normalized(text).includes("callora.admin_revoke_device")) {
        throw Object.assign(new Error("conflicting immutable request"), { code: "23505" });
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));

    await expect(repository.revokeDeviceByAdministrator({
      organizationId: ORGANIZATION_ID,
      deviceId: DEVICE_ID,
      actorUserId: USER_ID,
      requestId: REQUEST_ID,
      requestFingerprint: "f".repeat(64),
      reason: "Lost corporate handset",
      auditEventId: AUDIT_ID,
      outboxEventId: OUTBOX_ID,
      at: TIMESTAMP,
    })).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
    expect(client.calls.map((call) => normalized(call.text))).toContain("rollback");
  });

  it("resolves an opaque session through the exact digest directory before entering tenant RLS", async () => {
    const tokenHash = "b".repeat(64);
    const client = new ScriptedClient(({ text }) =>
      normalized(text).includes("from callora.device_credentials as credential")
        ? [{
            credential_id: CREDENTIAL_ID,
            credential_type: "session",
            organization_id: ORGANIZATION_ID,
            employee_id: EMPLOYEE_ID,
            device_id: DEVICE_ID,
            installation_id: "android-installation-1",
            collection_mode: "android_call_log",
            lifecycle_state: "active",
            consent_current: true,
            ...deviceRow(),
          }]
        : []);
    const pool = new ScriptedPool(client, ({ text }) =>
      normalized(text).includes("callora.resolve_device_credential")
        ? [{ organization_id: ORGANIZATION_ID, credential_id: CREDENTIAL_ID }]
        : []);
    const repository = new PostgresCalloraRepository(pool);

    const context = await repository.resolveDeviceCredential({
      tokenHash,
      credentialType: "session",
      at: TIMESTAMP,
    });

    expect(context).toMatchObject({
      credentialId: CREDENTIAL_ID,
      credentialType: "session",
      organizationId: ORGANIZATION_ID,
      employeeId: EMPLOYEE_ID,
      deviceId: DEVICE_ID,
      installationId: "android-installation-1",
    });
    expect(pool.directCalls[0]?.values).toEqual([tokenHash, "session"]);
    expect(client.calls[2]?.values).toEqual([ORGANIZATION_ID, ""]);
    const lookup = client.calls.find((call) => normalized(call.text).includes("credential.token_hash = decode"));
    expect(lookup?.values).toEqual([ORGANIZATION_ID, CREDENTIAL_ID, tokenHash, "session", TIMESTAMP]);
  });

  it("consumes bootstrap, stores consent, inserts only a session hash, and activates atomically", async () => {
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.includes("resolve_mobile_collection_policy")) return [{
        id: POLICY_ID,
        policy_version: "call-metadata-v2",
        disclosure_version: "disclosure-v2",
        collection_mode: "android_call_log",
        purpose: "call_metadata",
        title: "Call metadata",
        summary: "Disclosure",
        disclosures: ["Metadata only"],
        content_hash: POLICY_HASH,
        effective_at: TIMESTAMP,
      }];
      if (sql.includes("callora.prepare_device_credential_request")) return [{
        request_id: REQUEST_ID,
        credential_id: NEW_CREDENTIAL_ID,
        lifecycle_state: "active",
        response_body: {
          requestId: REQUEST_ID,
          credentialState: "active",
          expiresAt: "2026-07-22T08:00:00.000Z",
        },
        replayed: false,
      }];
      if (sql.includes("callora.accept_device_collection_policy")) return [{
        consent_receipt_id: "10000000-0000-4000-8000-000000000904",
        replayed: false,
      }];
      if (sql.includes("from callora.employee_devices as device") && sql.includes("sim_cards")) {
        return [deviceRow("connected")];
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));
    const context = {
      credentialId: CREDENTIAL_ID,
      credentialType: "bootstrap" as const,
      organizationId: ORGANIZATION_ID,
      employeeId: EMPLOYEE_ID,
      deviceId: DEVICE_ID,
      installationId: "android-installation-1",
      collectionMode: "android_call_log" as const,
      credentialState: "active" as const,
      consentCurrent: false,
      permissions: {
        callLog: "unknown" as const,
        phoneState: "unknown" as const,
        contacts: "unknown" as const,
        notifications: "unknown" as const,
        recordingFiles: "unknown" as const,
        backgroundExecution: "unknown" as const,
      },
    };
    const sessionHash = "c".repeat(64);

    const result = await repository.activateMobileDevice({
      context,
      activation: {
        requestId: REQUEST_ID,
        proposedSessionCredential: `cls_${"A".repeat(43)}`,
        policy: { id: POLICY_ID, contentHash: POLICY_HASH },
        consent: {
          acceptedAt: TIMESTAMP,
          purpose: "call_metadata",
        },
        permissions: {
          callLog: "granted",
          phoneState: "granted",
          contacts: "denied",
          notifications: "granted",
          recordingFiles: "unknown",
          backgroundExecution: "granted",
        },
      },
      sessionCredential: {
        id: NEW_CREDENTIAL_ID,
        credentialType: "session",
        tokenHash: sessionHash,
        expiresAt: "2026-07-22T08:00:00.000Z",
        requestId: REQUEST_ID,
        lifecycleState: "active",
      },
      requestFingerprint: "b".repeat(64),
      policy: {
        id: POLICY_ID,
        contentHash: POLICY_HASH,
        policyVersion: "call-metadata-v2",
        disclosureVersion: "disclosure-v2",
        collectionMode: "android_call_log",
        purpose: "call_metadata",
        title: "Call metadata",
        summary: "Disclosure",
        disclosures: ["Metadata only"],
        effectiveAt: TIMESTAMP,
      },
      at: TIMESTAMP,
    });

    expect(result?.device.status).toBe("connected");
    const statements = client.calls.map((call) => normalized(call.text));
    const transitionIndex = statements.findIndex((sql) => sql.includes("callora.prepare_device_credential_request"));
    const consentIndex = statements.findIndex((sql) => sql.includes("callora.accept_device_collection_policy"));
    const commitIndex = statements.indexOf("commit");
    expect(transitionIndex).toBeGreaterThan(0);
    expect(consentIndex).toBeGreaterThan(transitionIndex);
    expect(commitIndex).toBeGreaterThan(consentIndex);
    expect(client.calls[transitionIndex]?.values).toContain(sessionHash);
    expect(statements.some((sql) => sql.startsWith("insert into callora.device_credentials"))).toBe(false);
    expect(statements.some((sql) => sql.startsWith("insert into callora.device_consent_receipts"))).toBe(false);
  });

  it("returns consent-required when activation policy changes inside the transaction", async () => {
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.includes("resolve_mobile_collection_policy")) return [policyRow()];
      if (sql.includes("callora.prepare_device_credential_request")) return [{
        credential_id: NEW_CREDENTIAL_ID,
        response_body: { expiresAt: "2026-07-22T08:00:00.000Z" },
        replayed: false,
      }];
      if (sql.includes("callora.accept_device_collection_policy")) {
        throw Object.assign(new Error("policy changed"), { code: "23503" });
      }
      return [];
    });
    const pool = new ScriptedPool(client, ({ text }) =>
      normalized(text).includes("resolve_mobile_collection_policy")
        ? [policyRow("30000000-0000-4000-8000-000000000099", "9".repeat(64))]
        : []);
    const repository = new PostgresCalloraRepository(pool);

    await expect(repository.activateMobileDevice({
      context: {
        credentialId: CREDENTIAL_ID,
        credentialType: "bootstrap",
        organizationId: ORGANIZATION_ID,
        employeeId: EMPLOYEE_ID,
        deviceId: DEVICE_ID,
        installationId: "android-installation-1",
        collectionMode: "android_call_log",
        credentialState: "active",
        consentCurrent: false,
        permissions: mobilePermissions(),
      },
      activation: {
        requestId: REQUEST_ID,
        proposedSessionCredential: `cls_${"A".repeat(43)}`,
        policy: { id: POLICY_ID, contentHash: POLICY_HASH },
        consent: { acceptedAt: TIMESTAMP, purpose: "call_metadata" },
        permissions: mobilePermissions(),
      },
      sessionCredential: {
        id: NEW_CREDENTIAL_ID,
        credentialType: "session",
        tokenHash: "c".repeat(64),
        expiresAt: "2026-07-22T08:00:00.000Z",
        requestId: REQUEST_ID,
        lifecycleState: "active",
      },
      requestFingerprint: "b".repeat(64),
      policy: mobilePolicy(),
      at: TIMESTAMP,
    })).rejects.toMatchObject({ statusCode: 409, code: "CONSENT_REQUIRED" });
  });

  it("returns consent-required when re-consent policy changes inside the transaction", async () => {
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.includes("resolve_mobile_collection_policy")) return [policyRow()];
      if (sql.includes("callora.reconsent_device_collection_policy")) {
        throw Object.assign(new Error("policy changed"), { code: "23503" });
      }
      return [];
    });
    const pool = new ScriptedPool(client, ({ text }) =>
      normalized(text).includes("resolve_mobile_collection_policy")
        ? [policyRow("30000000-0000-4000-8000-000000000098", "8".repeat(64))]
        : []);
    const repository = new PostgresCalloraRepository(pool);

    await expect(repository.reconsentMobileDevice({
      context: {
        credentialId: CREDENTIAL_ID,
        credentialType: "session",
        organizationId: ORGANIZATION_ID,
        employeeId: EMPLOYEE_ID,
        deviceId: DEVICE_ID,
        installationId: "android-installation-1",
        collectionMode: "android_call_log",
        credentialState: "active",
        consentCurrent: false,
        permissions: mobilePermissions(),
      },
      reconsent: {
        requestId: REQUEST_ID,
        policy: { id: POLICY_ID, contentHash: POLICY_HASH },
        consent: { acceptedAt: TIMESTAMP, purpose: "call_metadata" },
        permissions: mobilePermissions(),
      },
      requestFingerprint: "b".repeat(64),
      policy: mobilePolicy(),
      at: TIMESTAMP,
    })).rejects.toMatchObject({ statusCode: 409, code: "CONSENT_REQUIRED" });
  });

  it("returns consent-required when rotation preparation loses current consent in the transaction", async () => {
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.includes("callora.prepare_device_credential_request")) {
        throw Object.assign(new Error("consent changed"), { code: "55000" });
      }
      if (sql.includes("callora.device_has_current_collection_consent")) return [{ consent_current: false }];
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));

    await expect(repository.prepareDeviceSessionRotation({
      context: {
        credentialId: CREDENTIAL_ID,
        credentialType: "session",
        organizationId: ORGANIZATION_ID,
        employeeId: EMPLOYEE_ID,
        deviceId: DEVICE_ID,
        installationId: "android-installation-1",
        collectionMode: "android_call_log",
        credentialState: "active",
        consentCurrent: true,
        permissions: mobilePermissions(),
      },
      sessionCredential: {
        id: NEW_CREDENTIAL_ID,
        credentialType: "session",
        tokenHash: "e".repeat(64),
        expiresAt: "2026-07-22T08:00:00.000Z",
        rotatedFromCredentialId: CREDENTIAL_ID,
        requestId: REQUEST_ID,
        lifecycleState: "pending",
      },
      requestId: REQUEST_ID,
      requestFingerprint: "e".repeat(64),
      at: TIMESTAMP,
    })).rejects.toMatchObject({ statusCode: 409, code: "CONSENT_REQUIRED" });
  });

  it("returns consent-required without registering a batch when policy rolls in the transaction", async () => {
    const client = new ScriptedClient(({ text }) =>
      mobileTrustRows(normalized(text), false) ?? []);
    const repository = new PostgresCalloraRepository(new ScriptedPool(client), {
      callPiiCrypto: testCallPiiCrypto(),
    });

    await expect(repository.ingestMobileCallBatch({
      context: {
        credentialId: CREDENTIAL_ID,
        credentialType: "session",
        organizationId: ORGANIZATION_ID,
        employeeId: EMPLOYEE_ID,
        deviceId: DEVICE_ID,
        installationId: "android-installation-1",
        collectionMode: "android_call_log",
        credentialState: "active",
        consentCurrent: true,
        permissions: mobilePermissions(),
      },
      batch: {
        schemaVersion: 1,
        collectionMode: "android_call_log",
        batchId: "policy-race-batch",
        organizationId: ORGANIZATION_ID,
        employeeId: EMPLOYEE_ID,
        deviceId: DEVICE_ID,
        sentAt: TIMESTAMP,
        items: [],
      },
      payloadHash: "d".repeat(64),
      nextCursor: "signed-next-cursor",
      at: TIMESTAMP,
      allowWithoutCallLogPermission: false,
    })).rejects.toMatchObject({ statusCode: 409, code: "CONSENT_REQUIRED" });
    expect(client.calls.some((call) => normalized(call.text).includes("register_call_ingest_batch"))).toBe(false);
  });

  it("locks the active mobile trust context and persists heartbeat health fields", async () => {
    const client = new ScriptedClient(({ text }) =>
      mobileTrustRows(normalized(text)) ?? []);
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));

    const result = await repository.recordDeviceHeartbeat({
      context: {
        credentialId: CREDENTIAL_ID,
        credentialType: "session",
        organizationId: ORGANIZATION_ID,
        employeeId: EMPLOYEE_ID,
        deviceId: DEVICE_ID,
        installationId: "android-installation-1",
        collectionMode: "android_call_log",
        credentialState: "active",
        consentCurrent: true,
        permissions: {
          callLog: "granted",
          phoneState: "granted",
          contacts: "denied",
          notifications: "granted",
          recordingFiles: "unknown",
          backgroundExecution: "granted",
        },
      },
      heartbeat: {
        schemaVersion: 1,
        organizationId: ORGANIZATION_ID,
        employeeId: EMPLOYEE_ID,
        deviceId: DEVICE_ID,
        observedAt: TIMESTAMP,
        appVersion: "0.2.0",
        osVersion: "16",
        batteryPercent: 73,
        isCharging: false,
        networkType: "wifi",
        pendingCallCount: 4,
        pendingRecordingCount: 2,
        syncState: "syncing",
        permissions: {
          callLog: "granted",
          phoneState: "granted",
          contacts: "denied",
          notifications: "granted",
          recordingFiles: "unknown",
          backgroundExecution: "granted",
        },
      },
      at: TIMESTAMP,
    });

    expect(result).toMatchObject({ serverTime: TIMESTAMP, nextHeartbeatAfterSeconds: 900 });
    const lockIndexes = [
      "select linked_user_id, status from callora.employees",
      "select * from callora.employee_devices",
      "select id, employee_id, credential_type",
      "select id from callora.device_consent_receipts",
      "select status from callora.organizations",
    ].map((prefix) => client.calls.findIndex((call) => normalized(call.text).startsWith(prefix)));
    expect(lockIndexes).toEqual([...lockIndexes].sort((left, right) => left - right));
    const update = client.calls.find((call) =>
      normalized(call.text).startsWith("update callora.employee_devices set app_version"));
    expect(update?.values.slice(12)).toEqual([TIMESTAMP, 73, false, "wifi", 4, 2]);
  });

  it("reuses a pre-rotation mobile row ID instead of deriving an AAD-conflicting retry ID", async () => {
    const callPiiCrypto = testCallPiiCrypto();
    const newlyDerivedCallId = callPiiCrypto.deriveRowId({
      organizationId: ORGANIZATION_ID,
      source: "mobile_call_log",
      deviceId: DEVICE_ID,
      externalId: "android-call-0001",
    });
    const expectedCallId = CALL_ID;
    expect(newlyDerivedCallId).not.toBe(expectedCallId);
    const client = new ScriptedClient(({ text, values }) => {
      const sql = normalized(text);
      const trustRows = mobileTrustRows(sql);
      if (trustRows) return trustRows;
      if (sql.includes("callora.register_call_ingest_batch")) return [{ batch_id: INGEST_BATCH_ID }];
      if (sql.startsWith("select response_body from callora.call_ingest_batches")) return [{ response_body: null }];
      if (sql.startsWith("select external_id, id from callora.call_logs")) {
        return [{ external_id: "android-call-0001", id: expectedCallId }];
      }
      if (sql.includes("from callora.upsert_mobile_call_encrypted")) {
        return [{ call_log_id: values[0], outcome: "created" }];
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client), { callPiiCrypto });
    const result = await repository.ingestMobileCallBatch({
      context: {
        credentialId: CREDENTIAL_ID,
        credentialType: "session",
        organizationId: ORGANIZATION_ID,
        employeeId: EMPLOYEE_ID,
        deviceId: DEVICE_ID,
        installationId: "android-installation-1",
        collectionMode: "android_call_log",
        credentialState: "active",
        consentCurrent: true,
        permissions: deviceRow().call_log_permission === "granted"
          ? {
              callLog: "granted",
              phoneState: "granted",
              contacts: "denied",
              notifications: "granted",
              recordingFiles: "unknown",
              backgroundExecution: "granted",
            }
          : {
              callLog: "denied",
              phoneState: "unknown",
              contacts: "unknown",
              notifications: "unknown",
              recordingFiles: "unknown",
              backgroundExecution: "unknown",
            },
      },
      batch: {
        schemaVersion: 1,
        collectionMode: "android_call_log",
        batchId: "android-batch-0001",
        organizationId: ORGANIZATION_ID,
        employeeId: EMPLOYEE_ID,
        deviceId: DEVICE_ID,
        sentAt: TIMESTAMP,
        items: [{
          localId: "android-call-0001",
          phoneNumber: "+919811112222",
          direction: "incoming",
          disposition: "answered",
          startedAt: TIMESTAMP,
          durationSeconds: 60,
        }],
      },
      payloadHash: "d".repeat(64),
      nextCursor: "signed-next-cursor",
      at: TIMESTAMP,
      allowWithoutCallLogPermission: false,
    });

    expect(result?.items).toEqual([{
      localId: "android-call-0001",
      outcome: "created",
      callLogId: expectedCallId,
    }]);
    const statements = client.calls.map((call) => normalized(call.text));
    expect(statements.some((sql) => sql.includes("callora.register_call_ingest_batch"))).toBe(true);
    expect(statements.some((sql) => sql.includes("from callora.upsert_mobile_call_encrypted"))).toBe(true);
    const encryptedUpsert = client.calls.find((call) =>
      normalized(call.text).includes("from callora.upsert_mobile_call_encrypted"));
    expect(encryptedUpsert?.values).not.toContain("+919811112222");
    expect(Buffer.isBuffer(encryptedUpsert?.values[7])).toBe(true);
    expect(Buffer.isBuffer(encryptedUpsert?.values[8])).toBe(true);
    expect(Buffer.isBuffer(encryptedUpsert?.values[9])).toBe(true);
    const responseUpdateIndex = statements.findIndex((sql) => sql.startsWith("update callora.call_ingest_batches set processed_item_count"));
    expect(responseUpdateIndex).toBeGreaterThan(0);
    expect(statements.indexOf("commit")).toBeGreaterThan(responseUpdateIndex);
    const deviceLock = client.calls.find((call) =>
      normalized(call.text).startsWith("select * from callora.employee_devices"));
    expect(deviceLock?.values).toEqual([ORGANIZATION_ID, DEVICE_ID]);
  });

  it("ingests a manual call through the encrypted-only database function", async () => {
    const callPiiCrypto = testCallPiiCrypto();
    let encryptedInsertValues: unknown[] | undefined;
    const client = new ScriptedClient(({ text, values }) => {
      const sql = normalized(text);
      if (sql.startsWith("insert into callora.api_idempotency_keys")) {
        return [{ id: REQUEST_ID, request_fingerprint: "f".repeat(64), resource_id: null }];
      }
      if (sql.includes("callora.insert_manual_call_encrypted")) {
        encryptedInsertValues = values;
        return [{ id: values[0] }];
      }
      if (sql.includes("from callora.call_logs as call_log") && sql.includes("call_log.id = $2::uuid")) {
        const inserted = encryptedInsertValues;
        if (!inserted) throw new Error("Manual call lookup occurred before encrypted insert");
        return [{
          id: inserted[0],
          organization_id: inserted[1],
          employee_id: inserted[2],
          device_id: inserted[3],
          sim_card_id: null,
          external_id: inserted[4],
          source: "manual",
          direction: inserted[5],
          disposition: inserted[6],
          phone_number: null,
          contact_name: null,
          pii_encryption_version: inserted[7],
          pii_key_version: inserted[8],
          pii_blind_index_key_version: inserted[9],
          phone_number_ciphertext: inserted[10],
          phone_number_nonce: inserted[11],
          phone_number_blind_index: inserted[12],
          contact_name_ciphertext: inserted[13],
          contact_name_nonce: inserted[14],
          contact_name_blind_index: inserted[15],
          pii_encrypted_at: inserted[16],
          is_internal: inserted[17],
          started_at: inserted[18],
          answered_at: inserted[19],
          ended_at: inserted[20],
          duration_seconds: inserted[21],
          ring_duration_seconds: inserted[22],
          is_within_working_hours: inserted[23],
          recording_status: "not_expected",
          is_pinned: false,
          ingest_fingerprint: inserted[24],
          created_at: inserted[25],
          updated_at: inserted[25],
          note_count: 0,
        }];
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client), { callPiiCrypto });

    const result = await repository.ingestCall({
      organizationId: ORGANIZATION_ID,
      actorUserId: USER_ID,
      idempotencyKey: "manual-call-idempotency-1",
      fingerprint: "f".repeat(64),
      at: TIMESTAMP,
      input: {
        employeeId: EMPLOYEE_ID,
        externalId: "manual-call-encrypted-1",
        phoneNumber: "+919811112222",
        displayName: "Asha Patel",
        direction: "outgoing",
        disposition: "answered",
        isInternal: false,
        startedAt: TIMESTAMP,
        durationSeconds: 60,
        isWithinWorkingHours: true,
      },
    });

    expect(result.call.participant).toEqual({
      phoneNumber: "+919811112222",
      displayName: "Asha Patel",
      isInternal: false,
    });
    expect(encryptedInsertValues).not.toContain("+919811112222");
    expect(encryptedInsertValues).not.toContain("Asha Patel");
    expect(Buffer.isBuffer(encryptedInsertValues?.[10])).toBe(true);
    expect(Buffer.isBuffer(encryptedInsertValues?.[13])).toBe(true);
    expect(client.calls.some((call) => normalized(call.text).startsWith("insert into callora.call_logs")))
      .toBe(false);
  });

  it("prepares a pending replacement without revoking the active session", async () => {
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.includes("callora.prepare_device_credential_request")) return [{
        request_id: REQUEST_ID,
        credential_id: NEW_CREDENTIAL_ID,
        lifecycle_state: "pending",
        response_body: {
          requestId: REQUEST_ID,
          credentialState: "pending",
          expiresAt: "2026-07-22T08:00:00.000Z",
        },
        replayed: false,
      }];
      if (sql.startsWith("select created_at from callora.device_credentials")) {
        return [{ created_at: TIMESTAMP }];
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));
    const prepared = await repository.prepareDeviceSessionRotation({
      context: {
        credentialId: CREDENTIAL_ID,
        credentialType: "session",
        organizationId: ORGANIZATION_ID,
        employeeId: EMPLOYEE_ID,
        deviceId: DEVICE_ID,
        installationId: "android-installation-1",
        collectionMode: "android_call_log",
        credentialState: "active",
        consentCurrent: true,
        permissions: {
          callLog: "granted",
          phoneState: "granted",
          contacts: "denied",
          notifications: "granted",
          recordingFiles: "unknown",
          backgroundExecution: "granted",
        },
      },
      sessionCredential: {
        id: NEW_CREDENTIAL_ID,
        credentialType: "session",
        tokenHash: "e".repeat(64),
        expiresAt: "2026-07-22T08:00:00.000Z",
        rotatedFromCredentialId: CREDENTIAL_ID,
        requestId: REQUEST_ID,
        lifecycleState: "pending",
      },
      requestId: REQUEST_ID,
      requestFingerprint: "e".repeat(64),
      at: TIMESTAMP,
    });

    expect(prepared).toMatchObject({ requestId: REQUEST_ID, replayed: false });
    const statements = client.calls.map((call) => normalized(call.text));
    const transitionIndex = statements.findIndex((sql) => sql.includes("callora.prepare_device_credential_request"));
    expect(transitionIndex).toBeGreaterThan(0);
    expect(statements.some((sql) => sql.startsWith("insert into callora.device_credentials"))).toBe(false);
    expect(statements.some((sql) => sql.includes("set lifecycle_state = 'revoked'"))).toBe(false);
    expect(statements.indexOf("commit")).toBeGreaterThan(transitionIndex);
  });

  it("validates outbox claim bounds before reserving a connection", async () => {
    const pool = new ScriptedPool(new ScriptedClient(() => []));
    const repository = new PostgresCalloraRepository(pool);

    await expect(repository.claimOutboxEvents({
      organizationId: ORGANIZATION_ID,
      workerId: " ",
      at: TIMESTAMP,
      limit: 101,
    })).rejects.toThrow("workerId");
    expect(pool.connectCount).toBe(0);
  });

  it("generates database-compatible raw UUID identifiers", () => {
    const value = new UuidIdGenerator().next("pairing");
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(value).not.toContain("pairing_");
  });
});
