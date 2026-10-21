# macOS Notarization & Developer ID Guide (OPTIONAL FUTURE PUBLIC DISTRIBUTION)

> [!NOTE]
> **OPTIONAL FUTURE PUBLIC DISTRIBUTION ONLY**
> 
> This document details the Apple Developer Program, Developer ID signing, and Apple Notarization workflow.
> **This is NOT required for internal company deployment.**
> For company-internal staff Macs, use the zero-cost local code signing strategy documented in [LOCAL_SIGNING.md](LOCAL_SIGNING.md).

---

## 1. Context & Purpose (Public Distribution)

When distributing `Zalo Recorder.app` to external or unmanaged third-party macOS devices:
1. **Gatekeeper Validation**: External macOS devices without pre-trusted local certificates require binaries to be notarized by Apple to bypass Gatekeeper quarantine (`spctl`).
2. **Developer ID Stability**: Apple Developer ID certificates allow public installations to persist TCC permissions without requiring manual Keychain certificate installation.
3. **Internal vs Public**: For internal machines where certificates can be generated in the local Keychain, use [LOCAL_SIGNING.md](LOCAL_SIGNING.md) instead.

---

## 2. Prerequisites

1. Active **Apple Developer Program** membership.
2. **Developer ID Application** certificate installed in your macOS Keychain:
   - Check with:
     ```bash
     security find-identity -p codesigning -v
     ```
   - The output should contain: `"Developer ID Application: <Your Organization/Name> (<TEAM_ID>)"`.
3. App Store Connect API Key or App-Specific Password for Apple notary service.

---

## 3. Keychain Credentials Setup for Notarytool

Configure `notarytool` with stored credentials in your Keychain so credentials are not exposed in scripts:

### Option A: App Store Connect API Key (Recommended for CI/CD)
```bash
xcrun notarytool store-credentials "AC_NOTARY_PROFILE" \
  --key "/path/to/AuthKey_<KEY_ID>.p8" \
  --key-id "<KEY_ID>" \
  --issuer "<ISSUER_UUID>"
```

### Option B: Apple ID App-Specific Password
```bash
xcrun notarytool store-credentials "AC_NOTARY_PROFILE" \
  --apple-id "developer@yourcompany.com" \
  --team-id "<TEAM_ID>" \
  --password "<app-specific-password>"
```

Verify profile:
```bash
xcrun notarytool history --keychain-profile "AC_NOTARY_PROFILE"
```

---

## 4. Packaging and Signing

The build script `local-agent/run.sh --package --release` packages `Zalo Recorder.app` and signs all binaries using hardened runtime (`--options runtime`) and timestamps (`--timestamp`):

```bash
# Package into production app bundle
./local-agent/run.sh --package --release
```

To sign manually:
```bash
APP_PATH="$HOME/Applications/Zalo Recorder.app"
IDENTITY="Developer ID Application: Your Name (TEAM_ID)"
ENTITLEMENTS="local-agent/entitlements.plist"

codesign --force --deep --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  --sign "$IDENTITY" \
  "$APP_PATH"
```

Verify signature:
```bash
codesign --verify --deep --strict --verbose=4 "$APP_PATH"
spctl --assess -vv --type exec "$APP_PATH/Contents/MacOS/zalo-recorder"
```

---

## 5. Submission to Apple Notary Service

Create a compressed archive for submission:
```bash
APP_PATH="$HOME/Applications/Zalo Recorder.app"
ZIP_PATH="ZaloRecorder.zip"

ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"
```

Submit to Apple:
```bash
xcrun notarytool submit "$ZIP_PATH" \
  --keychain-profile "AC_NOTARY_PROFILE" \
  --wait
```

The `--wait` flag polls until notarization completes. You will receive an outcome of `Accepted` or `Invalid`.

---

## 6. Stapling Notarization Ticket

After Apple approves the submission, staple the ticket directly to the `.app` bundle so Gatekeeper can validate it offline:

```bash
xcrun stapler staple "$APP_PATH"
```

Verify stapling:
```bash
xcrun stapler validate "$APP_PATH"
```

And verify with Gatekeeper:
```bash
spctl --assess -vv --type install "$APP_PATH"
```
Expected output:
```
/Users/.../Applications/Zalo Recorder.app: accepted
source=Notarized Developer ID
```

---

## 7. Troubleshooting Notarization Failures

If `notarytool submit` reports `status: Invalid`:

1. Retrieve the detailed log using the submission ID:
   ```bash
   xcrun notarytool log <SUBMISSION_ID> --keychain-profile "AC_NOTARY_PROFILE"
   ```
2. Common causes:
   - **Missing Hardened Runtime**: Ensure `--options runtime` was passed to `codesign`.
   - **Missing Secure Timestamp**: Ensure `--timestamp` was included during codesign.
   - **Invalid Entitlements**: Check `entitlements.plist` does not request private or restricted entitlements without Apple permission.
   - **Unsigned Nested Binaries**: If helper binaries/libraries are included inside `Contents/MacOS` or `Contents/Frameworks`, each must be signed individually before signing the outer bundle.
