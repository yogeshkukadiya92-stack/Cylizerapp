# Release, pilot and rollback runbook

## Before release

1. Pin the commit SHA and run `npm run check`, Android checks and iOS Swift tests.
2. Apply migrations to a restored production-like clone; record duration, locks,
   row counts and roll-forward/rollback assessment.
3. Run `release:load-smoke` at 2× forecast peak and perform backup/restore,
   export, deletion, alert and incident drills.
4. Complete `LAUNCH_EVIDENCE_TEMPLATE.json`; the launch command must return zero:
   `npm run release:launch-gate -- /secure/path/launch-evidence.json`.
5. Confirm legal/store approvals, subprocessors, support rota and status channel.

## Deployment

- Migrate once with the least-privilege migration role, deploy API/workers, then
  web/mobile. Enable high-risk features per organization, never globally first.
- Smoke test two distinct tenants, negative cross-tenant access, OIDC, ingestion,
  dashboard, lead update, report generation/download and audit events.
- Observe error rate, p95, pool saturation, queue age and notification failures.

## Rollback

- Disable feature flags and new worker claims first. Roll application images to
  the previous immutable SHA if schema compatibility is proven.
- Never reverse a destructive migration. Restore only after incident-command
  approval; preserve the affected database for investigation.
- Re-run tenant-isolation and reconciliation checks before reopening mutations.
