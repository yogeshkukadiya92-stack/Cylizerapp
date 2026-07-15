# Callora iOS companion

iOS 17+ SwiftUI companion for CRM and management workflows. Open `Package.swift`
in Xcode, select an iOS simulator, set `CALLORA_API_URL`, and run `CalloraIOS`.

This baseline intentionally does not claim or attempt general iOS cellular call
history synchronization. Calls are user-initiated with `tel:` and followed by an
explicit post-call update. Production distribution still requires OIDC/ASWebAuthenticationSession,
Keychain token persistence, APNs entitlements, privacy manifests, signing and App Store review metadata.
