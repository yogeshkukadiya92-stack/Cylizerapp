# Phase 4 CRM design specification

The Phase 4 lead workspace extends the existing Callora application shell. The
desktop and mobile concepts are visual specifications, not raster UI assets:
all labels, controls, tables, timelines, and states remain native React/HTML.

## Reference concepts

- `outputs/callora-phase4-lead-pipeline-concept.png` — desktop split workspace,
  native size 1556 × 1011.
- `outputs/callora-phase4-lead-pipeline-mobile-concept.png` — responsive lead
  list and bottom-sheet detail state, native size 853 × 1844.

## Visible-copy lock

- Page title: `Lead pipeline`
- Supporting line: `Own every opportunity from first call to next action.`
- Actions: `Import CSV`, `Add lead`, `Call`, `Add note`,
  `Schedule follow-up`
- Search: `Search leads, phone or company`
- Queues: `All leads`, `Not contacted`, `Overdue`, `Unreturned calls`
- Columns: `Lead`, `Status`, `Owner`, `Last contact`, `Next follow-up`,
  `Source`
- Selected lead: `Ramesh Traders`, `+91 98765 43210`, `Priya Sharma`,
  `Qualified`
- Timeline: `Missed incoming call`, `Follow-up scheduled`,
  `Status changed to Qualified`, `Note added`
- Next work: `Today, 4:30 PM`, `Discuss annual order`, `High priority`

Copy may change only when real server state changes the entity value. New
above-the-fold marketing text, badges, or decorative labels are out of scope.

## Design system

- Background: true white surfaces on `#f7f9fb`; never cream or tinted white.
- Text: `#10233f`; secondary text `#66748a`.
- Primary: `#0b9277`; strong `#08755f`; soft selection `#e8f7f2`.
- Borders: `#e1e6ec`; stronger divider `#d4dce5`.
- Semantic status colors reuse the existing restrained blue, warning, danger,
  and green tokens. Status is always accompanied by text.
- Typography: DM Sans; 28–32 px page title, 15–16 px row content, 13–14 px
  controls, 11–12 px secondary metadata.
- Radius: 8–12 px. Shadows are limited to the existing low-elevation token.
- Icons: the existing Lucide outline family at 1.8–2 px stroke. Icon-only
  actions require accessible names.
- Container model: lead table/list is primary. The detail panel is a split
  rail on desktop and a dismissible bottom sheet on small screens. No card
  grid, nested bento layout, gradient, glow, glass, or decorative imagery.

## Component inventory

- Existing `AppShell`, `Sidebar`, and `TopBar`
- Leads page header and permission/data-source state
- Search and queue toolbar
- Cursor-paged lead table / structured mobile rows
- Selected lead detail panel
- Status and owner controls
- Activity timeline
- Next-follow-up summary
- Add-lead, add-note, and schedule-follow-up dialogs
- Import preview is a later Phase 4 slice and must not be represented as an
  inert success path.

## Responsive and interaction rules

- At desktop widths, keep a table/detail split close to 65/35.
- At tablet widths, the detail panel may overlay the table while retaining
  context and keyboard dismissal.
- At 720 px and below, provide a page-local search field, horizontal queue
  tabs, 44 px action targets, structured rows, and a bottom-sheet detail view.
- The page itself must not overflow horizontally. Only the queue rail may
  scroll horizontally.
- Search, filtering, selection, create, note, schedule, complete, status, and
  assignment actions must change real local/server state and expose loading,
  empty, permission, error, conflict, and success states.
- OIDC/production runtimes never fall back to local/demo mutations.

## Fidelity gates

Before Phase 4 handoff, compare the latest browser render with both concepts at
their native aspect where practical. Check shell geometry, visible copy, table
density, split-panel proportions, typography, palette, status treatment,
selection state, mobile touch sizing, and overflow. Functional tests alone do
not satisfy this visual gate.
