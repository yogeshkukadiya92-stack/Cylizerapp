# Phase 8 handoff — iOS companion

## Delivered

- iOS 17+ SwiftUI package with root-owned dependencies, independent tab
  NavigationStacks and focused Leads, Metrics, Notifications and Settings views.
- Secure-token sign-in boundary, assigned-lead list/search, cancellable debounce,
  loading/error/empty states and pull-to-refresh.
- User-initiated `tel:` calls and explicit post-call status/note workflow.
- Idempotency keys and a bounded offline mutation retry queue.
- Privacy-safe notification copy, organization/session surfaces and explicit
  wording that general iOS cellular history is not synchronized.
- Swift compiler build and XCTest validation.

## Production gates

- Xcode application project, bundle/team/signing setup and real iPhone simulator
  plus physical-device UI/VoiceOver testing.
- OIDC through `ASWebAuthenticationSession`, Keychain-backed refresh-token
  rotation, organization picker and server-driven permission tests.
- APNs registration/provider wiring with generic lock-screen payloads, background
  retry persistence and conflict-resolution UI.
- Privacy manifest, App Store privacy answers/screenshots/review notes and
  regional default-dialer entitlement spike behind a disabled feature flag.

Open `apps/ios/Package.swift` in Xcode for the current runnable companion.
