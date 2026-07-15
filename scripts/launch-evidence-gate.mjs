import { readFile } from "node:fs/promises";

export function verifyLaunchEvidence(evidence) {
  const errors = [];
  if (evidence?.version !== 1) errors.push("Evidence version must be 1.");
  if ((evidence?.security?.openCritical ?? -1) !== 0 || (evidence?.security?.openHigh ?? -1) !== 0) errors.push("Security must have zero open critical/high findings.");
  if (!evidence?.security?.independentReviewId) errors.push("Independent security review evidence is required.");
  const load = evidence?.load ?? {}; if (!(load.peakRequestsPerSecond > 0) || !(load.sustainedRequestsPerSecond >= load.peakRequestsPerSecond * 2) || !(load.errorRate < 0.01) || !(load.p95Ms <= load.targetP95Ms)) errors.push("Load evidence must prove 2x headroom, <1% errors, and target p95.");
  const restore = evidence?.restore ?? {}; if (!restore.evidenceId || !(restore.actualRpoMinutes <= restore.targetRpoMinutes) || !(restore.actualRtoMinutes <= restore.targetRtoMinutes)) errors.push("Restore drill must meet documented RPO and RTO.");
  const pilots = Array.isArray(evidence?.pilots) ? evidence.pilots : []; if (pilots.length < 2 || pilots.some((pilot) => pilot.normalUseDays < 14 || !pilot.signOffId)) errors.push("Two pilots with at least 14 normal-use days and sign-off are required.");
  if (!evidence?.privacy?.counselApprovalId || !evidence?.privacy?.dpaApprovalId || !evidence?.privacy?.subprocessorApprovalId) errors.push("Counsel, DPA, and subprocessor approvals are required.");
  const stores = evidence?.stores ?? {}; if (!stores.playApproved || !stores.appStoreApproved) errors.push("Enabled mobile stores must be approved.");
  const drills = evidence?.drills ?? {}; if (!drills.exportEvidenceId || !drills.deletionEvidenceId || !drills.incidentEvidenceId || !drills.rollbackEvidenceId) errors.push("Export, deletion, incident, and rollback drill evidence is required.");
  if (!evidence?.owners?.product || !evidence?.owners?.engineering || !evidence?.owners?.security || !evidence?.owners?.support) errors.push("Product, engineering, security, and support owners must sign off.");
  return errors;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const file = process.argv[2]; if (!file) { process.stderr.write("Usage: node scripts/launch-evidence-gate.mjs <evidence.json>\n"); process.exitCode = 2; }
  else { try { const evidence = JSON.parse(await readFile(file, "utf8")); const errors = verifyLaunchEvidence(evidence); if (errors.length) { process.stderr.write(`Launch blocked:\n${errors.map((error) => `- ${error}`).join("\n")}\n`); process.exitCode = 1; } else process.stdout.write("Launch evidence verified.\n"); } catch (error) { process.stderr.write(`Launch evidence unavailable: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; } }
}
