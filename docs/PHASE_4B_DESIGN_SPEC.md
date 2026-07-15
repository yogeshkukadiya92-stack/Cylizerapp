# Callora Phase 4B design and behavior specification

Phase 4B completes the operational lead workflows that were intentionally
deferred from the Phase 4A foundation. The web and Android concepts are visual
specifications: all data, controls, tables, charts, forms, and status feedback
remain native React/HTML or Jetpack Compose UI.

## Reference concepts

- `outputs/callora-phase4b-lead-operations-concept.png` — desktop CSV import
  preview, result inspection, and resumable import history.
- `outputs/callora-phase4b-lead-reports-concept.png` — desktop conversion,
  trend, owner, and source reporting.
- `outputs/callora-phase4b-android-post-call-concept.png` — Android post-dial
  lead update sheet with encrypted offline queue feedback.

## Product truth and copy lock

The implementation must not imply work that the system cannot prove.

- Operations title: `Lead operations`
- Operations subtitle: `Import, assign and reconcile leads with confidence.`
- Operations tabs: `Pipeline`, `Imports`, `Assignment rules`
- Import actions: `Preview import`, `Import valid rows`,
  `Download error CSV`, `Resume`
- Import outcomes: `Valid`, `Duplicate`, `Error`, `Imported`
- Report title: `Lead reports`
- Report subtitle:
  `See conversion, follow-up and owner performance in one place.`
- Report actions: `Apply filters`, `Export CSV`
- Android title: `Update lead`
- Post-dial context:
  `Back from Phone — add an update if you spoke to this lead.`
- Offline feedback: `Offline · update will sync automatically`
- Security feedback:
  `Your update is encrypted on this device until synced.`
- Android actions: `Not now`, `Queue update`

`ACTION_DIAL` only opens the system dialer. Returning to Callora must never be
presented as evidence that a call connected or completed.

## Shared visual system

- Surfaces: true white on cool gray `#f7f9fb`; never cream.
- Text: deep navy `#10233f`; secondary slate `#66748a`.
- Primary: Callora teal `#0b9277`, strong `#08755f`, soft `#e8f7f2`.
- Dividers: `#e1e6ec`, with the existing stronger border token where needed.
- Typography: existing DM Sans stack. Page titles are 28–32 px, primary row
  text 14–16 px, control text 13–14 px, metadata 11–12 px.
- Icons: existing Lucide outline family on web and matching platform-standard
  outline icons on Android. Icon-only actions require accessible names.
- Radius: 8–12 px with the existing low elevation only.
- Container model: tables, lists, split rails, dialogs, and bottom sheets. Do
  not convert the workflows into a bento/card grid.
- Semantic colors always include a text label or icon; color is never the only
  carrier of status.

## CSV import workflow

```text
select file -> parse locally -> server preview -> inspect decisions
                                       |               |
                                       |               +-> fix source file
                                       +-> commit valid rows -> complete
                                                          |
                                                          +-> resume safely
```

- The web parser supports UTF-8 BOM, CRLF, quoted commas/newlines, escaped
  quotes, malformed-row evidence, duplicate headers, and strict file/row
  bounds. It does not use a naïve comma split.
- The browser never stores CSV rows or phone numbers in local storage.
- The server is authoritative for validation, scope, duplicate detection,
  assignment, and import counts.
- Preview and commit use stable request IDs. Reusing an ID with a different
  payload is a conflict, not a second import.
- Valid phone values are encrypted at rest; invalid raw phone values are not
  persisted. Error downloads contain only a masked last four digits.
- Existing-lead and in-file duplicates are visible and skipped. An import
  never silently merges two people.
- A closed or interrupted job remains visible in recent imports and can resume
  from its persisted row state.

## Assignment workflow

- Manual assignment continues through the lead compare-and-swap update and is
  recorded in lead activity history.
- Rules are ordered, versioned, tenant-scoped, and can be disabled without
  deleting their evidence.
- A rule may filter by source, temperature, and status, then choose a fixed
  owner or a deterministic round-robin owner list.
- Dry-run displays the matched count and owner distribution before any
  existing unassigned lead is changed.
- Applying rules to existing leads is off by default and requires an explicit
  confirmation.

## Call-link correction

- Correction is one atomic request, never a client-side unlink followed by a
  separate link.
- The request includes the expected current lead, replacement lead or `null`,
  a request ID, and a required reason.
- The API verifies tenant, team, permission, and current-link state while
  holding the correction transaction lock.
- Old link history remains immutable. Both the unlink and new manual link are
  represented in lead activity history.
- Desktop exposes correction from a linked-call timeline row. Mobile web uses
  a full-height activity dialog so the action is not hidden with the inline
  timeline.

## Android post-call update

- Status, note, and optional follow-up form one encrypted, durable command.
- The request UUID is generated once before persistence and is reused for
  every retry. The server applies or replays the whole command atomically.
- The authenticated device employee is the only allowed owner/actor. Client
  employee identifiers are not accepted.
- The Room queue uses dedicated AES-GCM associated data and keeps user text out
  of plaintext SQLite columns and logs.
- Network/I/O, 408, 429, and 5xx outcomes retry. Version conflicts are retained
  for review. Permanent validation or authorization failures are visible.
- Revocation, re-enrollment, stale consent, or unreadable security state purge
  the queue and its key consistently with the existing call queue boundary.
- The sheet is always available from assigned-lead detail. A lifecycle return
  from the system dialer may suggest the sheet, but never proves a call.

## Reporting definitions

- Reports are organization-scoped and require `reports.read`.
- Filters are explicit date range, owner, team, and source. The API rejects an
  inverted or excessive range.
- Conversion is won leads divided by the selected lead cohort.
- Pipeline values use directly labeled horizontal progression bars.
- Trend points expose visible values and a semantic table/list fallback; no
  result depends on hover.
- Owner and source sections remain sortable/readable tables with no lead-level
  name, email, or phone data.
- The response declares generation time, organization timezone, and metric
  definition version.

## Responsive and accessibility gates

- Desktop retains the existing shell and practical table density.
- At 720 px and below, import/rule/correction surfaces become full-height
  sheets; preview rows become structured rows rather than causing page-level
  horizontal overflow.
- Dialogs restore focus, support Escape, constrain focus, and lock background
  scroll. Every control is keyboard reachable with a visible focus state.
- Android targets are at least 48 dp and the bottom action bar remains visible
  with the keyboard and system navigation insets.
- Loading, empty, permission, validation, conflict, retry, and success states
  all have plain-language feedback.

## Fidelity gates

Before Phase 4B handoff, compare the latest browser/Android render with the
three concepts. Check shell geometry, visible copy, table density, typography,
true-white palette, status treatment, chart labels, dialog/sheet anatomy,
mobile touch targets, and overflow. Functional tests do not replace this
visual review.
