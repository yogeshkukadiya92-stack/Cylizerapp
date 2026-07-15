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
});
