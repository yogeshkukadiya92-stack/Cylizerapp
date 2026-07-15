import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { CallPiiCrypto, parseCallPiiKeyring } from "../../src/call-pii-crypto.js";
import { PostgresCalloraRepository } from "../../src/postgres/repository.js";
import type { PgClientLike, PgPoolLike } from "../../src/postgres/types.js";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000101";
const ROLE_ID = "10000000-0000-4000-8000-000000000201";
const TEAM_ID = "10000000-0000-4000-8000-000000000401";
const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000501";
const LEAD_ID = "10000000-0000-4000-8000-000000000c01";
const STATUS_ID = "10000000-0000-4000-8000-000000000d01";
const FOLLOW_UP_ID = "10000000-0000-4000-8000-000000000e01";
const CALL_ID = "10000000-0000-4000-8000-000000000a01";
const DEVICE_ID = "10000000-0000-4000-8000-000000000601";
const CREDENTIAL_ID = "10000000-0000-4000-8000-000000000901";
const RULE_ID = "10000000-0000-4000-8000-000000000f01";
const IMPORT_JOB_ID = "10000000-0000-4000-8000-000000000b01";
const IMPORT_ROW_ID = "10000000-0000-4000-8000-000000000b02";
const OTHER_TEAM_ID = "10000000-0000-4000-8000-000000000402";
const OTHER_EMPLOYEE_ID = "10000000-0000-4000-8000-000000000502";
const TIMESTAMP = "2026-07-15T08:00:00.000Z";
const PRIMARY_PHONE = "+919811112222";
const ALTERNATE_PHONE = "+919822223333";

interface QueryCall {
  text: string;
  values: unknown[];
}

type Script = (call: QueryCall) => QueryResultRow[] | Promise<QueryResultRow[]>;

function queryResult<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
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
    return queryResult(await this.script(call) as Row[]);
  }

  release(): void {
    this.released = true;
  }
}

class ScriptedPool implements PgPoolLike {
  connectCount = 0;

  constructor(readonly client: ScriptedClient) {}

  async query<Row extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<Row>> {
    return queryResult([]);
  }

  async connect(): Promise<PgClientLike> {
    this.connectCount += 1;
    return this.client;
  }

  async end(): Promise<void> {}
}

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function piiCrypto(): CallPiiCrypto {
  return new CallPiiCrypto(parseCallPiiKeyring({
    encryptionKeys: `1:${Buffer.alloc(32, 1).toString("base64url")}`,
    activeKeyVersion: "1",
    rowIdKey: Buffer.alloc(32, 7).toString("base64url"),
    blindIndexKeys: `1:${Buffer.alloc(32, 9).toString("base64url")}`,
    activeBlindIndexKeyVersion: "1",
  }));
}

function actorRow(overrides: QueryResultRow = {}): QueryResultRow {
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
    user_email: "actor@aster.test",
    user_display_name: "Aarav Shah",
    user_status: "active",
    user_created_at: TIMESTAMP,
    user_updated_at: TIMESTAMP,
    ...overrides,
  };
}

function roleRow(systemKey: "manager" | "employee"): QueryResultRow {
  return {
    id: ROLE_ID,
    organization_id: ORGANIZATION_ID,
    name: systemKey === "manager" ? "Manager" : "Employee",
    system_key: systemKey,
    is_editable: false,
    permissions: systemKey === "manager"
      ? ["leads.read", "leads.manage", "leads.assign"]
      : ["leads.read", "leads.manage"],
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  };
}

function statusRow(): QueryResultRow {
  return {
    id: STATUS_ID,
    organization_id: ORGANIZATION_ID,
    name: "New",
    color: "#2f83ee",
    position: 1,
    is_initial: true,
    is_won: false,
    is_lost: false,
    is_active: true,
  };
}

function encryptedLeadRow(
  crypto: CallPiiCrypto,
  overrides: QueryResultRow = {},
): QueryResultRow {
  const primary = crypto.encryptField({
    organizationId: ORGANIZATION_ID,
    rowId: LEAD_ID,
    field: "phone_number",
  }, PRIMARY_PHONE);
  const alternate = crypto.encryptField({
    organizationId: ORGANIZATION_ID,
    rowId: LEAD_ID,
    field: "alternate_phone_number",
  }, ALTERNATE_PHONE);
  return {
    id: LEAD_ID,
    organization_id: ORGANIZATION_ID,
    team_id: TEAM_ID,
    status_id: STATUS_ID,
    assigned_employee_id: EMPLOYEE_ID,
    created_by_user_id: USER_ID,
    updated_by_user_id: USER_ID,
    first_name: "Asha",
    last_name: "Patel",
    company_name: "Asha Textiles",
    email: "asha@example.test",
    source: "manual",
    source_reference: null,
    temperature: "warm",
    tag_ids: [],
    custom_fields: { segment: "growth" },
    version: 7,
    created_at: "2026-07-14T08:00:00.000Z",
    updated_at: TIMESTAMP,
    phone_encryption_version: primary.formatVersion,
    phone_key_version: primary.keyVersion,
    phone_blind_index_key_version: primary.blindIndexKeyVersion,
    phone_number_ciphertext: primary.ciphertext,
    phone_number_nonce: primary.nonce,
    phone_number_blind_index: primary.blindIndex,
    alternate_phone_encryption_version: alternate.formatVersion,
    alternate_phone_key_version: alternate.keyVersion,
    alternate_phone_blind_index_key_version: alternate.blindIndexKeyVersion,
    alternate_phone_number_ciphertext: alternate.ciphertext,
    alternate_phone_number_nonce: alternate.nonce,
    alternate_phone_number_blind_index: alternate.blindIndex,
    ...overrides,
  };
}

function leadItemRow(crypto: CallPiiCrypto, overrides: QueryResultRow = {}): QueryResultRow {
  return {
    ...encryptedLeadRow(crypto),
    lead_status_record: statusRow(),
    assigned_employee_record: {
      id: EMPLOYEE_ID,
      display_name: "Aarav Shah",
      team_name: "Inside Sales",
    },
    next_follow_up_record: null,
    overdue_follow_up_count: 0,
    unreturned_missed_call_count: 0,
    ...overrides,
  };
}

function leadItemFromInsert(values: unknown[]): QueryResultRow {
  return {
    id: values[0],
    organization_id: values[1],
    team_id: values[2],
    status_id: values[3],
    assigned_employee_id: values[4],
    created_by_user_id: values[5],
    updated_by_user_id: values[5],
    first_name: values[6],
    last_name: values[7],
    company_name: values[8],
    email: values[9],
    source: values[10],
    source_reference: values[11],
    temperature: values[12],
    phone_encryption_version: values[13],
    phone_key_version: values[14],
    phone_blind_index_key_version: values[15],
    phone_number_ciphertext: values[16],
    phone_number_nonce: values[17],
    phone_number_blind_index: values[18],
    alternate_phone_encryption_version: values[21],
    alternate_phone_key_version: values[22],
    alternate_phone_blind_index_key_version: values[23],
    alternate_phone_number_ciphertext: values[24],
    alternate_phone_number_nonce: values[25],
    alternate_phone_number_blind_index: values[26],
    tag_ids: values[29],
    custom_fields: values[30],
    converted_at: values[31],
    lost_at: values[32],
    version: 1,
    created_at: values[20],
    updated_at: values[20],
    lead_status_record: statusRow(),
    assigned_employee_record: {
      id: EMPLOYEE_ID,
      display_name: "Aarav Shah",
      team_name: "Inside Sales",
    },
    next_follow_up_record: null,
    overdue_follow_up_count: 0,
    unreturned_missed_call_count: 0,
  };
}

function followUpRow(overrides: QueryResultRow = {}): QueryResultRow {
  return {
    id: FOLLOW_UP_ID,
    organization_id: ORGANIZATION_ID,
    team_id: TEAM_ID,
    lead_id: LEAD_ID,
    assigned_employee_id: EMPLOYEE_ID,
    created_by_user_id: USER_ID,
    title: "Review proposal",
    notes: null,
    due_at: "2026-07-15T07:30:00.000Z",
    reminder_at: null,
    priority: "high",
    status: "pending",
    version: 3,
    created_at: "2026-07-14T08:00:00.000Z",
    updated_at: "2026-07-14T08:00:00.000Z",
    ...overrides,
  };
}

function assignmentRuleRow(overrides: QueryResultRow = {}): QueryResultRow {
  return {
    id: RULE_ID,
    organization_id: ORGANIZATION_ID,
    team_id: TEAM_ID,
    name: "Round robin",
    priority: 10,
    active: true,
    conditions: {},
    strategy: "round_robin",
    round_robin_cursor: 0,
    version: 3,
    created_by_user_id: USER_ID,
    updated_by_user_id: USER_ID,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    ...overrides,
  };
}

function importJobRow(overrides: QueryResultRow = {}): QueryResultRow {
  return {
    id: IMPORT_JOB_ID,
    organization_id: ORGANIZATION_ID,
    request_id: "10000000-0000-4000-8000-000000000b03",
    request_fingerprint: "a".repeat(64),
    file_name: "leads.csv",
    status: "preview_ready",
    total_rows: 1,
    valid_rows: 1,
    duplicate_rows: 0,
    error_rows: 0,
    imported_rows: 0,
    processed_rows: 0,
    created_by_user_id: USER_ID,
    completed_at: null,
    last_error: null,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    ...overrides,
  };
}

function encryptedImportRow(
  crypto: CallPiiCrypto,
  options: {
    id?: string;
    rowNumber?: number;
    phone?: string;
    alternatePhone?: string | null;
    assignmentRuleVersion?: number;
  } = {},
): QueryResultRow {
  const rowId = options.id ?? IMPORT_ROW_ID;
  const phoneNumber = options.phone ?? PRIMARY_PHONE;
  const alternatePhoneNumber = options.alternatePhone === undefined
    ? ALTERNATE_PHONE : options.alternatePhone ?? undefined;
  const primary = crypto.encryptField({
    organizationId: ORGANIZATION_ID,
    rowId,
    field: "phone_number",
  }, phoneNumber);
  const alternate = alternatePhoneNumber === undefined ? undefined : crypto.encryptField({
    organizationId: ORGANIZATION_ID,
    rowId,
    field: "alternate_phone_number",
  }, alternatePhoneNumber);
  return {
    id: rowId,
    organization_id: ORGANIZATION_ID,
    job_id: IMPORT_JOB_ID,
    row_number: options.rowNumber ?? 1,
    decision: "valid",
    team_id: TEAM_ID,
    status_id: STATUS_ID,
    proposed_assigned_employee_id: EMPLOYEE_ID,
    assignment_rule_id: RULE_ID,
    assignment_rule_version: options.assignmentRuleVersion ?? 3,
    duplicate_row_number: null,
    duplicate_lead_id: null,
    imported_lead_id: null,
    first_name: "Asha",
    last_name: "Patel",
    company_name: null,
    email: "asha@example.test",
    source: "csv_import",
    status_name: "New",
    assigned_employee_code: null,
    tag_names: ["VIP", "Renewal"],
    custom_fields: { segment: "growth" },
    phone_encryption_version: primary.formatVersion,
    phone_key_version: primary.keyVersion,
    phone_blind_index_key_version: primary.blindIndexKeyVersion,
    phone_number_ciphertext: primary.ciphertext,
    phone_number_nonce: primary.nonce,
    phone_number_blind_index: primary.blindIndex,
    alternate_phone_encryption_version: alternate?.formatVersion ?? null,
    alternate_phone_key_version: alternate?.keyVersion ?? null,
    alternate_phone_blind_index_key_version: alternate?.blindIndexKeyVersion ?? null,
    alternate_phone_number_ciphertext: alternate?.ciphertext ?? null,
    alternate_phone_number_nonce: alternate?.nonce ?? null,
    alternate_phone_number_blind_index: alternate?.blindIndex ?? null,
    issues: [],
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  };
}

describe("PostgresCalloraRepository Phase 4 lead boundaries", () => {
  it("maps manager team scope and employee self scope from the tenant-bound actor query", async () => {
    async function loadActor(systemKey: "manager" | "employee") {
      const client = new ScriptedClient(({ text }) => {
        const sql = normalized(text);
        if (sql.includes("from callora.organizations as organization")) {
          return [actorRow({
            linked_employee_id: EMPLOYEE_ID,
            lead_team_names: ["Inside Sales", "Enterprise"],
          })];
        }
        if (sql.includes("array_agg(role_permission.permission_key")) return [roleRow(systemKey)];
        return [];
      });
      const actor = await new PostgresCalloraRepository(new ScriptedPool(client))
        .findActor(ORGANIZATION_ID, USER_ID);
      return { actor, client };
    }

    const manager = await loadActor("manager");
    expect(manager.actor?.leadScope).toEqual({
      kind: "teams",
      teamNames: ["Inside Sales", "Enterprise"],
    });
    const managerActorQuery = manager.client.calls.find((call) =>
      normalized(call.text).includes("from callora.organizations as organization"));
    expect(managerActorQuery?.values).toEqual([ORGANIZATION_ID, USER_ID]);
    expect(normalized(managerActorQuery?.text ?? "")).toContain("from callora.membership_team_scopes as scope");
    expect(normalized(managerActorQuery?.text ?? "")).toContain("scope.organization_id = membership.organization_id");
    expect(normalized(managerActorQuery?.text ?? "")).toContain("employee.linked_user_id = app_user.id");

    const employee = await loadActor("employee");
    expect(employee.actor?.leadScope).toEqual({ kind: "assigned", employeeId: EMPLOYEE_ID });
  });

  it("binds tenant and team/self scope in list and detail SQL while mapping encrypted detail", async () => {
    const listClient = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.includes("count(*)::integer as total")) {
        return [{ total: 4, not_contacted: 2, overdue: 1, unreturned_calls: 1 }];
      }
      return [];
    });
    const listRepository = new PostgresCalloraRepository(new ScriptedPool(listClient));
    const page = await listRepository.listLeads({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "teams", teamNames: ["Inside Sales"] },
      filter: { queue: "all" },
      limit: 25,
      at: TIMESTAMP,
    });
    expect(page.summary).toEqual({ total: 4, notContacted: 2, overdue: 1, unreturnedCalls: 1 });
    const summaryQuery = listClient.calls.find((call) =>
      normalized(call.text).includes("count(*)::integer as total"));
    const listQuery = listClient.calls.find((call) =>
      normalized(call.text).includes("to_jsonb(lead_status) as lead_status_record"));
    for (const call of [summaryQuery, listQuery]) {
      const sql = normalized(call?.text ?? "");
      expect(sql).toContain("lead.organization_id = $1::uuid");
      expect(sql).toContain("scoped_team.organization_id = lead.organization_id");
      expect(sql).toContain("scoped_team.id = lead.team_id");
      expect(sql).toContain("scoped_team.name = any($3::text[])");
      expect(call?.values.slice(0, 3)).toEqual([ORGANIZATION_ID, TIMESTAMP, ["Inside Sales"]]);
    }

    const crypto = piiCrypto();
    const detailClient = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.includes("to_jsonb(lead_status) as lead_status_record")) return [leadItemRow(crypto)];
      if (sql.includes("from callora.lead_follow_ups") && sql.startsWith("select *")) return [followUpRow()];
      return [];
    });
    const detailRepository = new PostgresCalloraRepository(new ScriptedPool(detailClient), { callPiiCrypto: crypto });
    const detail = await detailRepository.findLeadDetail({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "assigned", employeeId: EMPLOYEE_ID },
      leadId: LEAD_ID,
      at: TIMESTAMP,
    });
    expect(detail?.item.lead).toMatchObject({
      id: LEAD_ID,
      organizationId: ORGANIZATION_ID,
      phoneNumber: PRIMARY_PHONE,
      alternatePhoneNumber: ALTERNATE_PHONE,
      version: 7,
    });
    expect(detail?.followUps[0]).toMatchObject({ id: FOLLOW_UP_ID, status: "overdue", version: 3 });
    const detailQuery = detailClient.calls.find((call) =>
      normalized(call.text).includes("to_jsonb(lead_status) as lead_status_record"));
    expect(normalized(detailQuery?.text ?? "")).toContain("lead.assigned_employee_id = $4::uuid");
    expect(detailQuery?.values).toEqual([ORGANIZATION_ID, TIMESTAMP, LEAD_ID, EMPLOYEE_ID]);
  });

  it("creates primary and alternate lead-phone envelopes without binding plaintext", async () => {
    const crypto = piiCrypto();
    let leadInsert: QueryCall | undefined;
    const client = new ScriptedClient(({ text, values }) => {
      const sql = normalized(text);
      if (sql.includes("from callora.lead_statuses") && sql.includes("is_active")) return [statusRow()];
      if (sql.includes("select employee.team_id")) return [{ team_id: TEAM_ID }];
      if (sql.startsWith("insert into callora.leads")) {
        leadInsert = { text, values };
        return [];
      }
      if (sql.includes("to_jsonb(lead_status) as lead_status_record")) {
        if (!leadInsert) throw new Error("Lead readback occurred before the encrypted insert");
        return [leadItemFromInsert(leadInsert.values)];
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client), { callPiiCrypto: crypto });
    const detail = await repository.createLead({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: USER_ID,
      at: TIMESTAMP,
      input: {
        firstName: "Asha",
        lastName: "Patel",
        phoneNumber: PRIMARY_PHONE,
        alternatePhoneNumber: ALTERNATE_PHONE,
        email: "asha@example.test",
        source: "manual",
        statusId: STATUS_ID,
        assignedEmployeeId: EMPLOYEE_ID,
        customFields: { segment: "growth" },
      },
    });

    expect(detail?.item.lead).toMatchObject({
      phoneNumber: PRIMARY_PHONE,
      alternatePhoneNumber: ALTERNATE_PHONE,
      assignedEmployeeId: EMPLOYEE_ID,
      version: 1,
    });
    expect(leadInsert).toBeDefined();
    expect(leadInsert?.values).not.toContain(PRIMARY_PHONE);
    expect(leadInsert?.values).not.toContain(ALTERNATE_PHONE);
    expect(Buffer.isBuffer(leadInsert?.values[16])).toBe(true);
    expect(Buffer.isBuffer(leadInsert?.values[17])).toBe(true);
    expect(Buffer.isBuffer(leadInsert?.values[18])).toBe(true);
    expect(Buffer.isBuffer(leadInsert?.values[24])).toBe(true);
    expect(Buffer.isBuffer(leadInsert?.values[25])).toBe(true);
    expect(Buffer.isBuffer(leadInsert?.values[26])).toBe(true);
    const insertSql = normalized(leadInsert?.text ?? "");
    expect(insertSql).toContain("phone_number_ciphertext");
    expect(insertSql).toContain("alternate_phone_number_ciphertext");
    expect(insertSql).not.toMatch(/(?:^|[,(\s])phone_number(?:[,)\s]|$)/);
    expect(insertSql).not.toMatch(/(?:^|[,(\s])alternate_phone_number(?:[,)\s]|$)/);
  });

  it("guards lead updates with expected-version CAS and increments the revision once", async () => {
    const crypto = piiCrypto();
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.includes("select lead.*") && sql.includes("for update")) return [encryptedLeadRow(crypto)];
      if (sql.includes("select * from callora.lead_statuses")) return [statusRow()];
      if (sql.startsWith("update callora.leads") && sql.includes("returning version")) return [{ version: 8 }];
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client), { callPiiCrypto: crypto });
    await repository.updateLead({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      leadId: LEAD_ID,
      actorUserId: USER_ID,
      canAssign: true,
      at: TIMESTAMP,
      request: { expectedVersion: 7, changes: { firstName: "Asha Updated" } },
    });

    const update = client.calls.find((call) => {
      const sql = normalized(call.text);
      return sql.startsWith("update callora.leads") && sql.includes("returning version");
    });
    const sql = normalized(update?.text ?? "");
    expect(sql).toContain("first_name = $3");
    expect(sql).toContain("version = version + 1");
    expect(sql).toContain("where organization_id = $1::uuid and id = $2::uuid");
    expect(sql).toContain("and version = $");
    expect(update?.values.slice(0, 3)).toEqual([ORGANIZATION_ID, LEAD_ID, "Asha Updated"]);
    expect(update?.values.at(-1)).toBe(7);
    expect(client.calls.map((call) => normalized(call.text))).toContain("commit");
  });

  it("completes a follow-up with CAS, increments both revisions, and binds tenant scope", async () => {
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.includes("select follow_up.*, lead.version as lead_version")) return [followUpRow({ lead_version: 7 })];
      if (sql.startsWith("update callora.lead_follow_ups")) return [{ lead_id: LEAD_ID }];
      if (sql.includes("select min(due_at) as next_due")) return [{ next_due: null }];
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));
    await repository.completeLeadFollowUp({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "teams", teamNames: ["Inside Sales"] },
      followUpId: FOLLOW_UP_ID,
      actorUserId: USER_ID,
      at: TIMESTAMP,
      input: { expectedVersion: 3 },
    });

    const locked = client.calls.find((call) =>
      normalized(call.text).includes("select follow_up.*, lead.version as lead_version"));
    expect(normalized(locked?.text ?? "")).toContain("for update of follow_up, lead");
    expect(normalized(locked?.text ?? "")).toContain("scoped_team.organization_id = lead.organization_id");
    expect(locked?.values).toEqual([ORGANIZATION_ID, FOLLOW_UP_ID, ["Inside Sales"]]);

    const followUpUpdate = client.calls.find((call) =>
      normalized(call.text).startsWith("update callora.lead_follow_ups"));
    const followUpSql = normalized(followUpUpdate?.text ?? "");
    expect(followUpSql).toContain("version = version + 1");
    expect(followUpSql).toContain("and version = $6::bigint");
    expect(followUpSql).toContain("and status = 'pending'");
    expect(followUpUpdate?.values).toEqual([
      ORGANIZATION_ID,
      FOLLOW_UP_ID,
      TIMESTAMP,
      USER_ID,
      TIMESTAMP,
      3,
    ]);
    const leadUpdate = client.calls.find((call) => {
      const sql = normalized(call.text);
      return sql.startsWith("update callora.leads") && sql.includes("next_follow_up_at");
    });
    expect(normalized(leadUpdate?.text ?? "")).toContain("version = version + 1");
    expect(leadUpdate?.values.slice(0, 2)).toEqual([ORGANIZATION_ID, LEAD_ID]);
  });

  it("rolls back with a conflict when follow-up completion loses the CAS race", async () => {
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.includes("select follow_up.*, lead.version as lead_version")) return [followUpRow()];
      if (sql.startsWith("update callora.lead_follow_ups")) return [];
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));

    await expect(repository.completeLeadFollowUp({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      followUpId: FOLLOW_UP_ID,
      actorUserId: USER_ID,
      at: TIMESTAMP,
      input: { expectedVersion: 3 },
    })).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });

    const statements = client.calls.map((call) => normalized(call.text));
    expect(statements).toContain("rollback");
    expect(statements).not.toContain("commit");
    expect(statements.some((sql) => sql.startsWith("update callora.leads"))).toBe(false);
  });

  it("re-evaluates current team scope for import list, detail, and commit access", async () => {
    const client = new ScriptedClient(() => []);
    const repository = new PostgresCalloraRepository(
      new ScriptedPool(client),
      { callPiiCrypto: piiCrypto() },
    );
    const access = {
      organizationId: ORGANIZATION_ID,
      scope: { kind: "teams" as const, teamNames: ["Inside Sales"] },
      actorUserId: USER_ID,
    };
    await repository.listLeadImports(access);
    await repository.findLeadImport({ ...access, jobId: IMPORT_JOB_ID });
    await repository.commitLeadImport({
      ...access,
      jobId: IMPORT_JOB_ID,
      input: { requestId: "10000000-0000-4000-8000-000000000b03" },
      requestFingerprint: "a".repeat(64),
      at: TIMESTAMP,
    });

    const accessQueries = client.calls.filter((call) => {
      const sql = normalized(call.text);
      return sql.includes("from callora.lead_import_jobs as job") && sql.includes("scoped_row");
    });
    expect(accessQueries).toHaveLength(3);
    for (const call of accessQueries) {
      const sql = normalized(call.text);
      expect(sql).toContain("job.created_by_user_id");
      expect(sql).toContain("from callora.lead_import_rows as scoped_row");
      expect(sql).toContain("scoped_team.name <> all");
      expect(call.values).toContain(USER_ID);
      expect(call.values).toContainEqual(["Inside Sales"]);
    }
  });

  it("locks mobile trust rows and replays a stale exact request minimally before mutable checks", async () => {
    const requestId = "10000000-0000-4000-8000-000000000b04";
    const fingerprint = "b".repeat(64);
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.startsWith("select linked_user_id, status from callora.employees")) {
        return [{ linked_user_id: USER_ID, status: "active" }];
      }
      if (sql.startsWith("select * from callora.employee_devices")) {
        return [{ employee_id: EMPLOYEE_ID, status: "connected", revoked_at: null }];
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
      if (sql.includes("device_has_current_collection_consent")) return [{ consent_current: true }];
      if (sql.includes("scope = 'mobile.lead.update'") && sql.startsWith("select request_fingerprint")) {
        return [{
          request_fingerprint: fingerprint,
          resource_id: LEAD_ID,
          response_body: { requestId, appliedLeadVersion: 8 },
        }];
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));
    const receipt = await repository.applyMobileLeadUpdate({
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
          contacts: "unknown",
          notifications: "granted",
          recordingFiles: "unknown",
          backgroundExecution: "granted",
        },
      },
      leadId: LEAD_ID,
      input: {
        schemaVersion: 1,
        requestId,
        expectedLeadVersion: 7,
        // Deliberately outside the first-apply window: an exact persisted
        // replay must still succeed after a lost response.
        occurredAt: "2026-06-01T08:00:00.000Z",
        note: { body: "Already applied" },
      },
      requestFingerprint: fingerprint,
      at: TIMESTAMP,
    });

    expect(receipt).toEqual({ requestId, replayed: true, appliedLeadVersion: 8 });
    const employeeLockIndex = client.calls.findIndex((call) =>
      normalized(call.text).startsWith("select linked_user_id, status from callora.employees"));
    const deviceLockIndex = client.calls.findIndex((call) =>
      normalized(call.text).startsWith("select * from callora.employee_devices"));
    const credentialLockIndex = client.calls.findIndex((call) =>
      normalized(call.text).startsWith("select id, employee_id, credential_type"));
    const consentLockIndex = client.calls.findIndex((call) =>
      normalized(call.text).startsWith("select id from callora.device_consent_receipts"));
    const organizationLockIndex = client.calls.findIndex((call) =>
      normalized(call.text).startsWith("select status from callora.organizations"));
    const trustLockIndexes = [employeeLockIndex, deviceLockIndex, credentialLockIndex,
      consentLockIndex, organizationLockIndex];
    expect(trustLockIndexes).toEqual([...trustLockIndexes].sort((a, b) => a - b));
    expect(normalized(client.calls[credentialLockIndex]?.text ?? "")).toContain("order by id for update");
    expect(client.calls.some((call) => normalized(call.text).includes("from callora.leads as lead"))).toBe(false);
  });

  it("rejects a stale first-time mobile update after the replay lookup", async () => {
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.startsWith("select linked_user_id, status from callora.employees")) {
        return [{ linked_user_id: USER_ID, status: "active" }];
      }
      if (sql.startsWith("select * from callora.employee_devices")) {
        return [{ employee_id: EMPLOYEE_ID, status: "connected", revoked_at: null }];
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
      if (sql.includes("device_has_current_collection_consent")) return [{ consent_current: true }];
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));
    await expect(repository.applyMobileLeadUpdate({
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
          contacts: "unknown",
          notifications: "granted",
          recordingFiles: "unknown",
          backgroundExecution: "granted",
        },
      },
      leadId: LEAD_ID,
      input: {
        schemaVersion: 1,
        requestId: "10000000-0000-4000-8000-000000000b12",
        expectedLeadVersion: 7,
        occurredAt: "2026-06-01T08:00:00.000Z",
        note: { body: "Too old" },
      },
      requestFingerprint: "8".repeat(64),
      at: TIMESTAMP,
    })).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });
    const replayLookup = client.calls.findIndex((call) => normalized(call.text).includes("scope = 'mobile.lead.update'"));
    expect(replayLookup).toBeGreaterThan(-1);
    expect(client.calls.some((call) => normalized(call.text).includes("from callora.leads as lead"))).toBe(false);
  });

  it("locks assignment rules, members, and active employees and advances no cursor for failed writes", async () => {
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.startsWith("insert into callora.api_idempotency_keys") &&
        sql.includes("lead.assignment.apply")) return [{ id: "ledger" }];
      if (sql.startsWith("select rule.*") && sql.includes("lead_assignment_rules as rule")) {
        return [assignmentRuleRow()];
      }
      if (sql.startsWith("select member.rule_id")) return [{
        rule_id: RULE_ID,
        employee_id: EMPLOYEE_ID,
        position: 0,
        member_team_id: TEAM_ID,
        employee_team_id: TEAM_ID,
        employee_status: "active",
      }];
      if (sql.startsWith("select lead.id, lead.team_id")) return [{
        id: LEAD_ID,
        team_id: TEAM_ID,
        status_id: STATUS_ID,
        source: "manual",
        temperature: null,
        version: 7,
      }];
      // Simulate a guarded lead write that no longer matches.
      if (sql.startsWith("update callora.leads") && sql.includes("assigned_employee_id = $3")) return [];
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));
    const result = await repository.applyLeadAssignmentRules({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: USER_ID,
      at: TIMESTAMP,
      input: {
        requestId: "10000000-0000-4000-8000-000000000b05",
        includeExistingUnassigned: true,
      },
      requestFingerprint: "c".repeat(64),
    });

    expect(result).toMatchObject({ matchedLeads: 1, appliedLeads: 0 });
    const ruleLock = client.calls.find((call) => normalized(call.text).startsWith("select rule.*"));
    const memberLock = client.calls.find((call) => normalized(call.text).startsWith("select member.rule_id"));
    expect(normalized(ruleLock?.text ?? "")).toContain("for update of rule");
    expect(normalized(memberLock?.text ?? "")).toContain("join callora.employees as employee");
    expect(normalized(memberLock?.text ?? "")).toContain("for update of member, employee");
    expect(client.calls.some((call) => normalized(call.text).includes("round_robin_cursor = round_robin_cursor +")))
      .toBe(false);
  });

  it("rejects assignment-rule team moves before member deletion", async () => {
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.startsWith("select rule.*") && sql.includes("for update")) return [assignmentRuleRow()];
      if (sql.startsWith("select employee_id") && sql.includes("lead_assignment_rule_employees")) {
        return [{ employee_id: EMPLOYEE_ID }];
      }
      if (sql.startsWith("select employee.id, employee.team_id")) {
        return [{ id: OTHER_EMPLOYEE_ID, team_id: OTHER_TEAM_ID }];
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));
    await expect(repository.updateLeadAssignmentRule({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: USER_ID,
      at: TIMESTAMP,
      ruleId: RULE_ID,
      input: { expectedVersion: 3, changes: { employeeIds: [OTHER_EMPLOYEE_ID] } },
    })).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });
    expect(client.calls.some((call) =>
      normalized(call.text).startsWith("delete from callora.lead_assignment_rule_employees"))).toBe(false);
  });

  it("allows an organization owner to unlink an archived cross-team current call link under row locks", async () => {
    const fingerprint = "d".repeat(64);
    const requestId = "10000000-0000-4000-8000-000000000b06";
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.startsWith("select call_log.id")) return [{ id: CALL_ID, team_id: TEAM_ID }];
      if (sql.startsWith("select * from callora.call_lead_links")) {
        return [{ id: "10000000-0000-4000-8000-000000000a02", lead_id: LEAD_ID }];
      }
      if (sql.startsWith("select lead.id, lead.team_id")) return [{
        id: LEAD_ID,
        team_id: OTHER_TEAM_ID,
        assigned_employee_id: null,
        archived_at: TIMESTAMP,
        team_name: "Former Team",
      }];
      if (sql.startsWith("insert into callora.api_idempotency_keys") &&
        sql.includes("lead.call_link.correct")) return [{ id: "ledger" }];
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));
    const result = await repository.correctCallLeadLink({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: USER_ID,
      callId: CALL_ID,
      at: TIMESTAMP,
      requestFingerprint: fingerprint,
      input: {
        requestId,
        expectedLeadId: LEAD_ID,
        replacementLeadId: null,
        reason: "Remove stale archived link",
      },
    });

    expect(result).toMatchObject({ previousLeadId: LEAD_ID, replacementLeadId: null });
    const leadLock = client.calls.find((call) =>
      normalized(call.text).startsWith("select lead.id, lead.team_id"));
    expect(normalized(leadLock?.text ?? "")).toContain("order by lead.id for update of lead");
  });

  it("does not let an invalid preview row reserve its phone against a later valid row", async () => {
    const crypto = piiCrypto();
    let jobId = IMPORT_JOB_ID;
    const stagedInserts: QueryCall[] = [];
    let duplicateLookups = 0;
    const client = new ScriptedClient(({ text, values }) => {
      const sql = normalized(text);
      if (sql.startsWith("select * from callora.lead_statuses")) return [statusRow()];
      if (sql.startsWith("select team.id, team.name")) return [{ id: TEAM_ID, name: "Inside Sales" }];
      if (sql.startsWith("select employee.id, employee.team_id")) return [];
      if (sql.startsWith("select rule.*") && sql.includes("lead_assignment_rules as rule")) return [];
      if (sql.startsWith("select lead.id from callora.leads")) {
        duplicateLookups += 1;
        return [];
      }
      if (sql.startsWith("insert into callora.lead_import_jobs")) {
        jobId = String(values[0]);
        return [];
      }
      if (sql.startsWith("insert into callora.lead_import_rows")) {
        stagedInserts.push({ text, values });
        return [];
      }
      if (sql.startsWith("select job.* from callora.lead_import_jobs")) return [importJobRow({
        id: jobId,
        total_rows: 2,
        valid_rows: 1,
        duplicate_rows: 0,
        error_rows: 1,
        processed_rows: 1,
      })];
      return [];
    });
    const repository = new PostgresCalloraRepository(
      new ScriptedPool(client),
      { callPiiCrypto: crypto },
    );
    const preview = await repository.previewLeadImport({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: USER_ID,
      at: TIMESTAMP,
      requestFingerprint: "9".repeat(64),
      input: {
        requestId: "10000000-0000-4000-8000-000000000b11",
        fileName: "invalid-first.csv",
        rows: [
          { firstName: "Invalid", phoneNumber: PRIMARY_PHONE, email: "invalid" },
          { firstName: "Valid", phoneNumber: PRIMARY_PHONE },
        ],
      },
    });

    expect(preview.job).toMatchObject({ validRows: 1, duplicateRows: 0, errorRows: 1 });
    expect(stagedInserts.map((call) => call.values[4])).toEqual(["invalid", "valid"]);
    expect(JSON.parse(String(stagedInserts[1]?.values[37]))).toEqual([]);
    expect(duplicateLookups).toBe(1);
  });

  it("serializes import commit per team, checks rule version, deduplicates both phones, and persists tags", async () => {
    const crypto = piiCrypto();
    const stagedRow = encryptedImportRow(crypto);
    let leadInsert: QueryCall | undefined;
    const client = new ScriptedClient(({ text, values }) => {
      const sql = normalized(text);
      if (sql.startsWith("select job.id from callora.lead_import_jobs")) return [{ id: IMPORT_JOB_ID }];
      if (sql.startsWith("insert into callora.api_idempotency_keys") &&
        sql.includes("lead.import.commit")) return [{ id: "ledger" }];
      if (sql.startsWith("select job.* from callora.lead_import_jobs") && sql.includes("for update")) {
        return [importJobRow()];
      }
      if (sql.startsWith("select * from callora.lead_import_rows")) return [stagedRow];
      if (sql.startsWith("select id, team_id, version, active")) return [assignmentRuleRow()];
      if (sql.startsWith("select member.rule_id, member.employee_id")) return [{
        rule_id: RULE_ID,
        employee_id: EMPLOYEE_ID,
        position: 0,
        member_team_id: TEAM_ID,
        employee_team_id: TEAM_ID,
        employee_status: "active",
      }];
      if (sql.startsWith("select lead.id from callora.leads")) return [];
      if (sql.startsWith("select is_won, is_lost from callora.lead_statuses")) {
        return [{ is_won: false, is_lost: false }];
      }
      if (sql.startsWith("select id from callora.employees")) return [{ id: EMPLOYEE_ID }];
      if (sql.startsWith("insert into callora.leads")) {
        leadInsert = { text, values };
        return [];
      }
      if (sql.startsWith("update callora.lead_assignment_rules") && sql.includes("returning version")) {
        return [{ version: 4 }];
      }
      if (sql.startsWith("select count(*)::integer as count") &&
        sql.includes("callora.lead_import_rows")) return [{ count: 0 }];
      if (sql.startsWith("update callora.lead_import_jobs") && sql.includes("returning *")) {
        return [importJobRow({
          status: "completed",
          imported_rows: 1,
          processed_rows: 1,
          completed_at: TIMESTAMP,
        })];
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(
      new ScriptedPool(client),
      { callPiiCrypto: crypto },
    );
    const result = await repository.commitLeadImport({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: USER_ID,
      jobId: IMPORT_JOB_ID,
      input: { requestId: "10000000-0000-4000-8000-000000000b07" },
      requestFingerprint: "e".repeat(64),
      at: TIMESTAMP,
    });

    expect(result?.job).toMatchObject({ status: "completed", importedRows: 1 });
    const teamLock = client.calls.find((call) =>
      normalized(call.text).includes("pg_advisory_xact_lock") &&
      String(call.values[0]).startsWith("lead-import-team:"));
    expect(teamLock?.values).toEqual([`lead-import-team:${ORGANIZATION_ID}:${TEAM_ID}`]);
    const duplicate = client.calls.find((call) =>
      normalized(call.text).startsWith("select lead.id from callora.leads"));
    expect(duplicate?.values).toHaveLength(10);
    expect(duplicate?.values).not.toContain(PRIMARY_PHONE);
    expect(duplicate?.values).not.toContain(ALTERNATE_PHONE);
    expect(leadInsert).toBeDefined();
    expect(leadInsert?.values[28]).toBe(JSON.stringify(["VIP", "Renewal"]));
    const ruleLockIndex = client.calls.findIndex((call) =>
      normalized(call.text).startsWith("select id, team_id, version, active"));
    const ownerLockIndex = client.calls.findIndex((call) =>
      normalized(call.text).startsWith("select member.rule_id, member.employee_id"));
    expect(ruleLockIndex).toBeGreaterThan(-1);
    expect(ownerLockIndex).toBeGreaterThan(ruleLockIndex);
  });

  it("rebases a 51-row round-robin import between resumable 50-row commit batches", async () => {
    const crypto = piiCrypto();
    const stagedRows = Array.from({ length: 51 }, (_, index) => {
      const rowNumber = index + 1;
      return encryptedImportRow(crypto, {
        id: `10000000-0000-4000-8000-${(0xb100 + rowNumber).toString(16).padStart(12, "0")}`,
        rowNumber,
        phone: `+91970000${String(rowNumber).padStart(4, "0")}`,
        alternatePhone: null,
        assignmentRuleVersion: 3,
      });
    });
    let commitNumber = 0;
    let ruleVersion = 3;
    let ruleCursor = 0;
    const cursorAdvances: number[] = [];
    const rebasedVersions: number[] = [];
    const insertedOwners: string[] = [];
    const client = new ScriptedClient(({ text, values }) => {
      const sql = normalized(text);
      if (sql.startsWith("select job.id from callora.lead_import_jobs")) return [{ id: IMPORT_JOB_ID }];
      if (sql.startsWith("insert into callora.api_idempotency_keys") &&
        sql.includes("lead.import.commit")) {
        commitNumber += 1;
        return [{ id: `ledger-${commitNumber}` }];
      }
      if (sql.startsWith("select job.* from callora.lead_import_jobs") && sql.includes("for update")) {
        return [importJobRow({
          total_rows: 51,
          valid_rows: 51,
          imported_rows: commitNumber === 1 ? 0 : 50,
          processed_rows: commitNumber === 1 ? 0 : 50,
          status: commitNumber === 1 ? "preview_ready" : "interrupted",
        })];
      }
      if (sql.startsWith("select * from callora.lead_import_rows")) {
        return stagedRows.filter((row) => row.decision === "valid").slice(0, 50);
      }
      if (sql.startsWith("select id, team_id, version, active")) {
        return [assignmentRuleRow({ version: ruleVersion, round_robin_cursor: ruleCursor })];
      }
      if (sql.startsWith("select member.rule_id, member.employee_id")) return [
        {
          rule_id: RULE_ID,
          employee_id: EMPLOYEE_ID,
          position: 0,
          member_team_id: TEAM_ID,
          employee_team_id: TEAM_ID,
          employee_status: "active",
        },
        {
          rule_id: RULE_ID,
          employee_id: OTHER_EMPLOYEE_ID,
          position: 1,
          member_team_id: TEAM_ID,
          employee_team_id: TEAM_ID,
          employee_status: "active",
        },
      ];
      if (sql.startsWith("select lead.id from callora.leads")) return [];
      if (sql.startsWith("select is_won, is_lost from callora.lead_statuses")) {
        return [{ is_won: false, is_lost: false }];
      }
      if (sql.startsWith("insert into callora.leads")) {
        insertedOwners.push(String(values[4]));
        return [];
      }
      if (sql.startsWith("update callora.lead_import_rows") && sql.includes("decision = 'imported'")) {
        const row = stagedRows.find((candidate) => candidate.id === values[1]);
        if (row) row.decision = "imported";
        return [];
      }
      if (sql.startsWith("update callora.lead_assignment_rules") && sql.includes("returning version")) {
        expect(Number(values[5])).toBe(ruleVersion);
        const increment = Number(values[2]);
        cursorAdvances.push(increment);
        ruleCursor += increment;
        ruleVersion += 1;
        return [{ version: ruleVersion }];
      }
      if (sql.startsWith("update callora.lead_import_rows") &&
        sql.includes("set assignment_rule_version")) {
        const nextVersion = Number(values[3]);
        rebasedVersions.push(nextVersion);
        for (const row of stagedRows) {
          if (row.decision === "valid" && row.assignment_rule_id === values[2]) {
            row.assignment_rule_version = nextVersion;
          }
        }
        return [];
      }
      if (sql.startsWith("select count(*)::integer as count") &&
        sql.includes("callora.lead_import_rows")) {
        return [{ count: stagedRows.filter((row) => row.decision === "valid").length }];
      }
      if (sql.startsWith("update callora.lead_import_jobs") && sql.includes("returning *")) {
        const remaining = stagedRows.filter((row) => row.decision === "valid").length;
        return [importJobRow({
          total_rows: 51,
          valid_rows: 51,
          imported_rows: 51 - remaining,
          processed_rows: 51 - remaining,
          status: remaining === 0 ? "completed" : "interrupted",
          completed_at: remaining === 0 ? TIMESTAMP : null,
        })];
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(
      new ScriptedPool(client),
      { callPiiCrypto: crypto },
    );

    const first = await repository.commitLeadImport({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: USER_ID,
      jobId: IMPORT_JOB_ID,
      input: { requestId: "10000000-0000-4000-8000-000000000b09" },
      requestFingerprint: "1".repeat(64),
      at: TIMESTAMP,
    });
    const second = await repository.commitLeadImport({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: USER_ID,
      jobId: IMPORT_JOB_ID,
      input: { requestId: "10000000-0000-4000-8000-000000000b10" },
      requestFingerprint: "2".repeat(64),
      at: TIMESTAMP,
    });

    expect(first?.job.status).toBe("interrupted");
    expect(second?.job.status).toBe("completed");
    expect(insertedOwners).toHaveLength(51);
    expect(insertedOwners.slice(0, 4)).toEqual([
      EMPLOYEE_ID, OTHER_EMPLOYEE_ID, EMPLOYEE_ID, OTHER_EMPLOYEE_ID,
    ]);
    expect(insertedOwners[50]).toBe(EMPLOYEE_ID);
    expect(cursorAdvances).toEqual([50, 1]);
    expect(rebasedVersions).toEqual([4, 5]);
    expect(ruleCursor).toBe(51);
  });

  it("invalidates a staged import owner when its persisted rule version drifts", async () => {
    const crypto = piiCrypto();
    const stagedRow = encryptedImportRow(crypto);
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.startsWith("select job.id from callora.lead_import_jobs")) return [{ id: IMPORT_JOB_ID }];
      if (sql.startsWith("insert into callora.api_idempotency_keys") &&
        sql.includes("lead.import.commit")) return [{ id: "ledger" }];
      if (sql.startsWith("select job.* from callora.lead_import_jobs") && sql.includes("for update")) {
        return [importJobRow()];
      }
      if (sql.startsWith("select * from callora.lead_import_rows")) return [stagedRow];
      if (sql.startsWith("select id, team_id, version, active")) {
        return [assignmentRuleRow({ version: 4, round_robin_cursor: 1 })];
      }
      if (sql.startsWith("select count(*)::integer as count") &&
        sql.includes("callora.lead_import_rows")) return [{ count: 0 }];
      if (sql.startsWith("update callora.lead_import_jobs") && sql.includes("returning *")) {
        return [importJobRow({
          status: "completed",
          valid_rows: 0,
          error_rows: 1,
          processed_rows: 1,
          completed_at: TIMESTAMP,
        })];
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(
      new ScriptedPool(client),
      { callPiiCrypto: crypto },
    );
    await repository.commitLeadImport({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: USER_ID,
      jobId: IMPORT_JOB_ID,
      input: { requestId: "10000000-0000-4000-8000-000000000b08" },
      requestFingerprint: "f".repeat(64),
      at: TIMESTAMP,
    });

    expect(client.calls.some((call) => normalized(call.text).startsWith("insert into callora.leads"))).toBe(false);
    const invalidation = client.calls.find((call) => {
      const sql = normalized(call.text);
      return sql.startsWith("update callora.lead_import_rows") && sql.includes("decision = 'invalid'");
    });
    expect(normalized(invalidation?.text ?? "")).toContain("assignment_rule_version = null");
    expect(stagedRow.assignment_rule_version).toBe(3);
    expect(JSON.parse(String(invalidation?.values[2]))).toEqual([expect.objectContaining({
      field: "assignedEmployeeCode",
      message: "The assignment rule changed; preview the import again",
    })]);
  });

  it("locks assignment employees canonically while preserving requested round-robin positions", async () => {
    const memberInserts: QueryCall[] = [];
    const client = new ScriptedClient(({ text, values }) => {
      const sql = normalized(text);
      if (sql.startsWith("select employee.id, employee.team_id")) return [
        { id: EMPLOYEE_ID, team_id: TEAM_ID },
        { id: OTHER_EMPLOYEE_ID, team_id: TEAM_ID },
      ];
      if (sql.startsWith("insert into callora.lead_assignment_rules")) return [assignmentRuleRow()];
      if (sql.startsWith("insert into callora.lead_assignment_rule_employees")) {
        memberInserts.push({ text, values });
      }
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));
    await repository.createLeadAssignmentRule({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: USER_ID,
      at: TIMESTAMP,
      input: {
        name: "Caller ordered",
        priority: 10,
        strategy: "round_robin",
        employeeIds: [OTHER_EMPLOYEE_ID, EMPLOYEE_ID],
      },
    });

    const employeeLock = client.calls.find((call) =>
      normalized(call.text).startsWith("select employee.id, employee.team_id"));
    expect(employeeLock?.values[1]).toEqual([EMPLOYEE_ID, OTHER_EMPLOYEE_ID]);
    expect(normalized(employeeLock?.text ?? "")).toContain("order by employee.id for update of employee");
    expect(memberInserts.map((call) => [call.values[3], call.values[4]])).toEqual([
      [OTHER_EMPLOYEE_ID, 0],
      [EMPLOYEE_ID, 1],
    ]);
  });

  it("uses the same explicit mobile trust lock helper for update, heartbeat, and ingest", () => {
    const prototype = PostgresCalloraRepository.prototype as unknown as Record<string, (...args: never[]) => unknown>;
    for (const method of ["applyMobileLeadUpdate", "recordDeviceHeartbeat", "ingestMobileCallBatch"]) {
      expect(String(prototype[method])).toContain("lockActiveMobileTrustWithClient");
    }
    const helperSource = String(prototype.lockActiveMobileTrustWithClient);
    const lockOrder = ["callora.employees", "callora.employee_devices", "callora.device_credentials",
      "callora.device_consent_receipts", "callora.organizations"].map((table) => helperSource.indexOf(table));
    expect(lockOrder.every((index) => index >= 0)).toBe(true);
    expect(lockOrder).toEqual([...lockOrder].sort((left, right) => left - right));
  });

  it("returns first answered active-link response metrics and excludes pre-creation calls in SQL", async () => {
    const client = new ScriptedClient(({ text }) => {
      const sql = normalized(text);
      if (sql.includes("as total_leads")) return [{
        total_leads: 2,
        converted_leads: 1,
        follow_ups_due: 0,
        average_first_response_seconds: "420",
      }];
      if (sql.includes("assigned_employee_id as employee_id")) return [{
        employee_id: EMPLOYEE_ID,
        display_name: "Aarav Shah",
        assigned: 2,
        contacted: 2,
        won: 1,
        overdue_follow_ups: 0,
        average_response_seconds: "420",
      }];
      if (sql.includes("as status_id")) return [{
        status_id: STATUS_ID,
        status_name: "New",
        color: "#2f83ee",
        is_won: false,
        is_lost: false,
        lead_count: 2,
      }];
      if (sql.includes("as bucket_start")) return [{ bucket_start: TIMESTAMP, created: 2, won: 1 }];
      if (sql.includes("select source")) return [{
        source: "manual", leads: 2, contacted: 2, qualified: 0, won: 1,
      }];
      return [];
    });
    const repository = new PostgresCalloraRepository(new ScriptedPool(client));
    const report = await repository.getLeadReport({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      filter: { from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
      timeZone: "Asia/Kolkata",
      at: TIMESTAMP,
    });

    expect(report.kpis.averageFirstResponseSeconds).toBe(420);
    expect(report.owners[0]?.averageResponseSeconds).toBe(420);
    const reportQueries = client.calls.filter((call) => normalized(call.text).includes("with cohort as materialized"));
    expect(reportQueries).toHaveLength(5);
    for (const call of reportQueries) {
      const sql = normalized(call.text);
      expect(sql).toContain("active_link.unlinked_at is null");
      expect(sql).toContain("call_log.answered_at >= lead.created_at");
      expect(sql).toContain("order by call_log.answered_at, call_log.id limit 1");
    }
  });
});
