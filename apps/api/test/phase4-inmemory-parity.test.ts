import { describe, expect, it } from "vitest";
import type { Employee } from "@callora/contracts";
import { InMemoryCalloraRepository, SequentialIdGenerator } from "../src/repository.js";

const ORGANIZATION_ID = "org_alpha";
const ACTOR_USER_ID = "user_org_alpha_owner";
const EMPLOYEE_ID = "emp_alpha_amit";
const AT = "2026-07-14T12:00:00.000Z";

function repository(): InMemoryCalloraRepository {
  return new InMemoryCalloraRepository(new SequentialIdGenerator());
}

describe("in-memory Phase 4B production parity", () => {
  it("does not reserve an invalid row phone and rechecks scope on preview replay", async () => {
    const repo = repository();
    const options = {
      organizationId: ORGANIZATION_ID,
      scope: { kind: "teams" as const, teamNames: ["Sales"] },
      actorUserId: ACTOR_USER_ID,
      requestFingerprint: "a".repeat(64),
      at: AT,
      input: {
        requestId: "inmemory-preview-scope-1",
        fileName: "invalid-first.csv",
        rows: [
          { firstName: "Invalid", phoneNumber: "+919700001001", email: "invalid" },
          { firstName: "Valid", phoneNumber: "+919700001001" },
        ],
      },
    };
    const preview = await repo.previewLeadImport(options);
    expect(preview.rows.map((row) => row.decision)).toEqual(["invalid", "valid"]);
    expect(preview.job).toMatchObject({ validRows: 1, duplicateRows: 0, errorRows: 1 });

    await expect(repo.previewLeadImport({
      ...options,
      scope: { kind: "teams", teamNames: [] },
    })).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    const committed = await repo.commitLeadImport({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "teams", teamNames: ["Sales"] },
      actorUserId: ACTOR_USER_ID,
      jobId: preview.job.id,
      input: { requestId: "inmemory-preview-scope-commit-1" },
      requestFingerprint: "b".repeat(64),
      at: AT,
    });
    expect(committed?.job).toMatchObject({ importedRows: 1, duplicateRows: 0, errorRows: 1 });
  });

  it("persists round-robin position across applies/imports and skips commit-time duplicates", async () => {
    const repo = repository();
    const primaryEmployee = await repo.findEmployee(ORGANIZATION_ID, EMPLOYEE_ID);
    expect(primaryEmployee).toBeDefined();
    const secondEmployee: Employee = {
      ...structuredClone(primaryEmployee!),
      id: "emp_alpha_bina",
      displayName: "Bina Shah",
      email: "bina@example.test",
      employeeCode: "BINA",
      linkedUserId: "user_org_alpha_owner",
    };
    const internals = repo as unknown as {
      employees: Map<string, Employee>;
      leadAssignmentRuleCursors: Map<string, number>;
    };
    internals.employees.set(secondEmployee.id, secondEmployee);

    const rule = await repo.createLeadAssignmentRule({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: ACTOR_USER_ID,
      at: AT,
      input: {
        name: "Google ads round robin",
        priority: 1,
        strategy: "round_robin",
        conditions: { sources: ["google_ads"] },
        employeeIds: [EMPLOYEE_ID, secondEmployee.id],
      },
    });
    expect(rule).toBeDefined();

    const createUnassigned = async (firstName: string, phoneNumber: string, at: string) => {
      const detail = await repo.createLead({
        organizationId: ORGANIZATION_ID,
        scope: { kind: "organization" },
        actorUserId: ACTOR_USER_ID,
        at,
        input: { firstName, phoneNumber, source: "google_ads" },
      });
      expect(detail).toBeDefined();
      return detail!.item.lead.id;
    };
    const apply = (requestId: string, at: string) => repo.applyLeadAssignmentRules({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: ACTOR_USER_ID,
      at,
      input: { requestId, includeExistingUnassigned: true },
      requestFingerprint: requestId.padEnd(64, "0").slice(0, 64),
    });

    const firstLeadId = await createUnassigned("First", "+919700002001", AT);
    expect((await apply("rr-apply-1", AT)).appliedLeads).toBe(1);
    expect((await repo.findLeadDetail({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      leadId: firstLeadId,
      at: AT,
    }))?.item.lead.assignedEmployeeId).toBe(EMPLOYEE_ID);

    const secondLeadId = await createUnassigned("Second", "+919700002002", "2026-07-14T12:01:00.000Z");
    const firstDryRun = await repo.dryRunLeadAssignmentRules({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: ACTOR_USER_ID,
      at: AT,
    });
    const secondDryRun = await repo.dryRunLeadAssignmentRules({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: ACTOR_USER_ID,
      at: AT,
    });
    expect(firstDryRun.distribution).toEqual([{ employeeId: secondEmployee.id, leadCount: 1 }]);
    expect(secondDryRun).toEqual(firstDryRun);
    expect((await apply("rr-apply-2", "2026-07-14T12:02:00.000Z")).appliedLeads).toBe(1);
    expect((await repo.findLeadDetail({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      leadId: secondLeadId,
      at: AT,
    }))?.item.lead.assignedEmployeeId).toBe(secondEmployee.id);

    const duplicatePreview = await repo.previewLeadImport({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: ACTOR_USER_ID,
      at: AT,
      requestFingerprint: "c".repeat(64),
      input: {
        requestId: "rr-import-duplicate-preview",
        fileName: "duplicate-race.csv",
        rows: [{ firstName: "Duplicate race", phoneNumber: "+919700002003", source: "google_ads" }],
      },
    });
    await repo.createLead({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: ACTOR_USER_ID,
      at: AT,
      input: {
        firstName: "Created during preview",
        phoneNumber: "+919700002003",
        source: "manual",
        assignedEmployeeId: EMPLOYEE_ID,
      },
    });
    const duplicateCommit = await repo.commitLeadImport({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: ACTOR_USER_ID,
      jobId: duplicatePreview.job.id,
      input: { requestId: "rr-import-duplicate-commit" },
      requestFingerprint: "d".repeat(64),
      at: AT,
    });
    expect(duplicateCommit?.job).toMatchObject({ importedRows: 0, duplicateRows: 1 });
    expect(internals.leadAssignmentRuleCursors.get(rule!.id)).toBe(2);

    const uniquePreview = await repo.previewLeadImport({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: ACTOR_USER_ID,
      at: AT,
      requestFingerprint: "e".repeat(64),
      input: {
        requestId: "rr-import-unique-preview",
        fileName: "unique.csv",
        rows: [{ firstName: "Imported", phoneNumber: "+919700002004", source: "google_ads" }],
      },
    });
    const uniqueCommit = await repo.commitLeadImport({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: ACTOR_USER_ID,
      jobId: uniquePreview.job.id,
      input: { requestId: "rr-import-unique-commit" },
      requestFingerprint: "f".repeat(64),
      at: AT,
    });
    expect(uniqueCommit?.job.importedRows).toBe(1);
    expect(internals.leadAssignmentRuleCursors.get(rule!.id)).toBe(3);

    const thirdLeadId = await createUnassigned("Third", "+919700002005", "2026-07-14T12:03:00.000Z");
    await apply("rr-apply-3", "2026-07-14T12:04:00.000Z");
    expect((await repo.findLeadDetail({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      leadId: thirdLeadId,
      at: AT,
    }))?.item.lead.assignedEmployeeId).toBe(secondEmployee.id);
  });

  it("buckets by organization timezone and reports first valid active-link response", async () => {
    const repo = repository();
    const createdAt = "2026-07-14T20:00:00.000Z";
    const lead = await repo.createLead({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      actorUserId: ACTOR_USER_ID,
      at: createdAt,
      input: {
        firstName: "Timezone",
        phoneNumber: "+919700003001",
        source: "facebook",
        assignedEmployeeId: EMPLOYEE_ID,
      },
    });
    expect(lead).toBeDefined();
    const ingest = async (externalId: string, startedAt: string, answeredAt: string, endedAt: string) =>
      repo.ingestCall({
        organizationId: ORGANIZATION_ID,
        actorUserId: ACTOR_USER_ID,
        idempotencyKey: externalId,
        fingerprint: externalId,
        at: endedAt,
        input: {
          externalId,
          employeeId: EMPLOYEE_ID,
          direction: "outgoing",
          disposition: "answered",
          phoneNumber: "+919700003001",
          isInternal: false,
          startedAt,
          answeredAt,
          endedAt,
          durationSeconds: 300,
          isWithinWorkingHours: true,
        },
      });
    await ingest(
      "pre-creation-response",
      "2026-07-14T19:40:00.000Z",
      "2026-07-14T19:50:00.000Z",
      "2026-07-14T19:55:00.000Z",
    );
    await ingest(
      "valid-response",
      "2026-07-14T20:05:00.000Z",
      "2026-07-14T20:10:00.000Z",
      "2026-07-14T20:15:00.000Z",
    );

    const report = await repo.getLeadReport({
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
      filter: {
        from: "2026-07-14T00:00:00.000Z",
        to: "2026-07-16T00:00:00.000Z",
        source: "facebook",
      },
      timeZone: "Asia/Kolkata",
      at: "2026-07-15T00:00:00.000Z",
    });

    expect(report.kpis).toMatchObject({ totalLeads: 1, averageFirstResponseSeconds: 600 });
    expect(report.owners.find((owner) => owner.employeeId === EMPLOYEE_ID)?.averageResponseSeconds).toBe(600);
    expect(report.trend).toEqual([{
      bucketStart: "2026-07-14T18:30:00.000Z",
      created: 1,
      won: 0,
    }]);
  });
});
