# Incident response runbook

## Severity and ownership

- SEV-1: confirmed tenant escape, credential compromise, destructive data loss,
  or complete production outage. Page engineering and security immediately.
- SEV-2: major workflow outage, delayed ingestion, or provider failure affecting
  multiple organizations. Page the on-call engineer and notify support.
- SEV-3: isolated degradation with a workaround. Create an owned incident ticket.

## First 15 minutes

1. Name an incident commander and scribe; record UTC start time and request IDs.
2. Protect customers: disable the affected feature flag, pause workers or move
   mutations to read-only. Never delete data as a containment shortcut.
3. Preserve sanitized logs, audit events, deployment SHA and database metrics.
4. For suspected tenant exposure, revoke affected sessions/API keys and involve
   privacy counsel; do not put phone numbers, recordings or tokens in chat.
5. Publish a status acknowledgement with impact and next-update time—no guesses.

## Recovery and closure

- Roll back application code only when the migration is backward-compatible;
  otherwise roll forward using the migration assessment.
- Validate `/health`, `/ready`, OIDC, tenant isolation, calls/leads and exports.
- Confirm queued jobs resume without duplicates and compare audit/outbox counts.
- Publish resolution, rotate compromised credentials and create a blameless
  review within two business days. Track every action with owner and due date.
