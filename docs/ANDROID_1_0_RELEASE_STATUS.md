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
- Long-lived 4,096-bit RSA production signing identity stored outside the
  repository, with its passwords held in macOS Keychain.
- Android release preflight passed for the production Railway API origin.
- Signed Enterprise APK and AAB built successfully. The APK signature verifies
  with SHA-256 certificate fingerprint
  `2F:5D:A6:4C:42:F2:A3:37:BA:2F:3B:A4:FF:DF:EA:E4:99:D2:6A:C3:E1:55:BA:19:F3:2B:7E:E7:D8:7A:6D:15`.
- Signed Enterprise APK installed and cold-launched on the available emulator
  as non-debuggable `co.callora.mobile` version `1.0.0`, with no crash-buffer
  entries during the launch smoke test.

## Release signing custody

The release keystore is stored outside the repository at the approved local
Callora signing location. Its generated passwords are stored in macOS Keychain
and are loaded into build-process memory only. A recoverable protected backup
must still be created before distribution. Build inputs are supplied only
through:

- `CALLORA_ANDROID_API_BASE_URL`
- `CALLORA_ANDROID_KEYSTORE_PATH`
- `CALLORA_ANDROID_KEY_ALIAS`
- `CALLORA_ANDROID_KEYSTORE_PASSWORD`
- `CALLORA_ANDROID_KEY_PASSWORD`

For every release, run `npm run release:preflight:android`, then build
`:app:assembleEnterpriseRelease` and `:app:bundleEnterpriseRelease`. Verify the
signer fingerprint and record fresh artifact SHA-256 checksums before installing
the release APK on a physical managed Android device.

## External launch approvals

- Product/legal approval of the exact call-metadata disclosure.
- Managed-distribution approval, or confirmation of Google Play restricted
  permission eligibility before any public listing.
- Physical API/OEM/background-power matrix and real-call sync validation.
- Protected backup and ownership record for the release keystore.
