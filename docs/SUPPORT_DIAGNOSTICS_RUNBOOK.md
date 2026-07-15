# Support diagnostics runbook

Collect only organization ID, user/device opaque ID, UTC time range, app version,
request ID, route name, HTTP status, sync cursor age and permission state. Never
request passwords, bearer tokens, pairing codes, phone numbers, recording files,
transcripts or raw database URLs.

Check `/health` and `/ready`, deployment SHA, OIDC issuer reachability, database
pool saturation, queue age, worker lease age, provider status and feature flags.
For mobile, capture OS/OEM, app flavor, consent-policy version, last successful
sync time and sanitized error code. Escalate suspected tenant exposure, data loss,
credential leakage or recording-consent failures immediately as SEV-1.
