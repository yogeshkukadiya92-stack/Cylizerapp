# Callora Android 1.0 release status

- Production API: `https://diplomatic-serenity-production-f138.up.railway.app`
- Application ID: `co.callora.mobile`
- Enterprise collection mode: `android_call_log`
- Version code/name: `1` / `1.0.0`
- Intended first distribution: controlled enterprise/managed APK

## Verified

- Production pairing and authoritative disclosure activation.
- Encrypted session persistence across app restart and in-place update.
- `READ_CALL_LOG` enterprise flavor boundary and Android permission gate.
- Android CallLog query on the supported emulator without SQL grammar extensions.
- WorkManager heartbeat and call batch requests returning HTTP 200.
- One fictional post-consent emulator call collected, uploaded, and stored as a
  completed one-item production batch with no pending or retrying rows.
- API test suite and enterprise Android unit/build checks.

## Release-signing gate

The release keystore must remain outside the repository. The signing owner must
explicitly approve creating or selecting the long-lived key and must keep a
recoverable protected backup. Build inputs are supplied only through:

- `CALLORA_ANDROID_API_BASE_URL`
- `CALLORA_ANDROID_KEYSTORE_PATH`
- `CALLORA_ANDROID_KEY_ALIAS`
- `CALLORA_ANDROID_KEYSTORE_PASSWORD`
- `CALLORA_ANDROID_KEY_PASSWORD`

After signing custody is approved, run `npm run release:preflight:android`, then
build `:app:assembleEnterpriseRelease` and `:app:bundleEnterpriseRelease`.
Verify the APK/AAB signer fingerprint and record artifact SHA-256 checksums before
installing the release APK on a physical managed Android device.

## External launch approvals

- Product/legal approval of the exact call-metadata disclosure.
- Managed-distribution approval, or confirmation of Google Play restricted
  permission eligibility before any public listing.
- Physical API/OEM/background-power matrix and real-call sync validation.
- Protected backup and ownership record for the release keystore.
