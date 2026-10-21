# Internal macOS Code Signing & TCC Persistence Guide

This document defines the **internal-only, zero-cost code signing strategy** for `Zalo Recorder.app` deployed across company-controlled Macs.

---

## 1. Strategy Overview

- **No Apple Developer Program Required**: Eliminates the \$99/year fee, Apple Developer ID Application certificates, and cloud notarization requirements.
- **Machine-Local Signing Identity**: Each Mac creates and stores its own self-signed code-signing certificate named `Zalo Recorder Local Signing` in the local user Keychain (`login.keychain-db`).
- **Cryptographic TCC Persistence**: By signing with a persistent named certificate instead of ad-hoc (`-s -`), macOS TCC binds permissions to the certificate's cryptographic leaf hash rather than the volatile per-build code directory hash (`cdhash`).
- **Strict Boundary**: This internal workflow is designed exclusively for company-controlled staff Macs. For public external distribution, see [NOTARIZATION.md](file:///Users/hoangthuy/ai-crm-worktrees/zalo-tcc-app/local-agent/NOTARIZATION.md) (optional future path).

---

## 2. Security Model & Machine Isolation

1. **Independent Keys**: Each Mac generates its **own** private key and certificate.
2. **Never Exported or Shared**:
   - Private keys remain exclusively in that Mac's Keychain.
   - Keys are **never committed to git**, never logged, never uploaded to CRM or servers, and never shared between staff Macs.
3. **Fail-Closed Packaging**:
   - Production packaging (`--package --local-release`) strictly requires `Zalo Recorder Local Signing`.
   - If the identity is absent, the build fails immediately with `LOCAL_SIGNING_IDENTITY_MISSING`. It will **never** silently fall back to ad-hoc signing.
4. **No System Security Tampering**:
   - Does NOT disable SIP (System Integrity Protection).
   - Does NOT disable or bypass Gatekeeper.
   - Does NOT directly edit SQLite TCC databases (`TCC.db`).

---

## 3. One-Time Local Certificate Setup

This is a one-time operation performed on each Mac before building or deploying local releases.

### Keychain Access UI Procedure (Recommended)

1. Open **Keychain Access** (`Applications > Utilities > Keychain Access` or via Spotlight).
2. From the menu bar, navigate to:
   **Keychain Access > Certificate Assistant > Create a Certificate...**
3. Configure the fields exactly as follows:
   - **Name**: `Zalo Recorder Local Signing`
   - **Identity Type**: `Self Signed Root`
   - **Certificate Type**: `Code Signing`
   - **Keychain**: `login`
4. Click **Create**, then click **Done**.

### Verifying Setup

Run the helper check in the repository:
```bash
./local-agent/run.sh --setup-local-signing
```

Or verify directly via macOS security tooling:
```bash
security find-identity -p codesigning -v
```

Expected output:
```
  1) <SHA-1 Fingerprint> "Zalo Recorder Local Signing"
     1 valid identities found
```

---

## 4. Packaging Local Release

To build and sign the application bundle:
```bash
./local-agent/run.sh --package --local-release
```

What this script executes:
1. Compiles the native Swift agent binary (`zalo-recorder`) with embedded `Info.plist` and Hardened Runtime entitlements.
2. Constructs the app bundle hierarchy at `local-agent/build/Zalo Recorder.app`.
3. Verifies `LOCAL_SIGNING_IDENTITY` exists in Keychain (fails closed if missing).
4. Signs the complete bundle with Hardened Runtime and entitlements:
   ```bash
   codesign --force --deep --options runtime --timestamp \
     --entitlements local-agent/entitlements.plist \
     --sign "Zalo Recorder Local Signing" \
     "local-agent/build/Zalo Recorder.app"
   ```
5. Verifies signature integrity (`codesign --verify --deep --strict`).
6. Extracts and validates the cryptographic designated requirement:
   ```bash
   codesign -d -r- "local-agent/build/Zalo Recorder.app"
   ```

### Ad-Hoc Dev Builds (Testing Only)
For rapid local testing that does not require TCC persistence:
```bash
./local-agent/run.sh --package --dev
```
> [!WARNING]
> Dev builds use ad-hoc signing (`--sign -`). Ad-hoc signatures tie process identity to `cdhash`, which changes on every rebuild. **Dev builds do not provide TCC persistence.**

---

## 5. Designated Requirement & Update Safeguards

The designated requirement (DR) is the cryptographic rule macOS TCC uses to determine if an updated binary is the same trusted application.

### Why Identifier-Only Matching is Insecure
If an update only checks `CFBundleIdentifier = com.local.zalo-recorder`, any process can claim that identifier. macOS TCC evaluates the cryptographic signature leaf.

### Automated Update Verification
When updating `~/Applications/Zalo Recorder.app`, `run.sh` enforces cryptographic compatibility:
1. Extracts `installed_req` from `~/Applications/Zalo Recorder.app`.
2. Extracts `candidate_req` from the candidate update.
3. Rejects update if either requirement contains `cdhash` (ad-hoc signature).
4. Verifies candidate satisfies installed requirement: `codesign -v -R="$installed_req" "$candidate"`.
5. Verifies requirement strings match identically.
6. If incompatible, aborts with `LOCAL_SIGNING_IDENTITY_MISMATCH` before replacing files.

Operators can verify candidate compatibility anytime:
```bash
./local-agent/run.sh --verify-update <candidate_app> [installed_app]
```

---

## 6. One-Time TCC Onboarding Workflow

After first-time installation of `~/Applications/Zalo Recorder.app`:

1. Launch interactive onboarding:
   ```bash
   ~/Applications/"Zalo Recorder.app"/Contents/MacOS/zalo-recorder --setup-permissions
   ```
2. The agent triggers system authorization dialogs for ungranted subsystems.
3. In **System Settings > Privacy & Security**, toggle **ON** `Zalo Recorder` under:
   - **Accessibility**
   - **Screen & System Audio Recording**
   - **Microphone**
4. Verify all permissions are recognized:
   ```bash
   ~/Applications/"Zalo Recorder.app"/Contents/MacOS/zalo-recorder --status
   ```
5. Heartbeat reports `permissions_ok = true` to CRM.

---

## 7. Certificate Lifecycle & Recovery

- **Validity**: Certificates created via Certificate Assistant default to 1 year or more.
- **Accidental Deletion**:
  If a developer or IT admin deletes `Zalo Recorder Local Signing` from Keychain:
  - Existing installed binaries continue running until modified.
  - Future builds cannot match earlier TCC grants.
  - The update check will halt with `LOCAL_SIGNING_IDENTITY_MISMATCH`.
  - **Recovery**: Re-create `Zalo Recorder Local Signing` via Certificate Assistant, perform a controlled re-install, and approve permissions once in System Settings.

---

## 8. Build A / Build B Acceptance Procedure

> [!IMPORTANT]
> **Status**: `LOCAL_SIGNING_TCC_PERSISTENCE = UNVERIFIED` until this procedure is executed on a live test device.

To formally certify that local signing preserves TCC permissions across updates:

### Phase 1: Build A (Baseline)
1. Ensure `Zalo Recorder Local Signing` exists in Keychain.
2. Package Build A:
   ```bash
   ./local-agent/run.sh --package --local-release
   ```
3. Install Build A:
   ```bash
   ./local-agent/run.sh --install local-release
   ```
4. Run interactive permission setup:
   ```bash
   ~/Applications/"Zalo Recorder.app"/Contents/MacOS/zalo-recorder --setup-permissions
   ```
5. Grant Microphone, Screen Recording, and Accessibility in System Settings.
6. Verify status reports all `GRANTED`:
   ```bash
   ~/Applications/"Zalo Recorder.app"/Contents/MacOS/zalo-recorder --status
   ```
7. Verify heartbeat to CRM reports `permissions_ok = true` and status `ONLINE`.

### Phase 2: Build B (Update with Identical Certificate)
1. Make a harmless text change in `local-agent/main.swift` (e.g. update log message).
2. Package Build B using the SAME local certificate:
   ```bash
   ./local-agent/run.sh --package --local-release
   ```
3. Verify candidate requirement compatibility:
   ```bash
   ./local-agent/run.sh --verify-update local-agent/build/"Zalo Recorder.app"
   ```
4. Update installation:
   ```bash
   ./local-agent/run.sh --install local-release
   ```
5. **DO NOT** open System Settings or re-grant permissions.
6. Inspect status immediately:
   ```bash
   ~/Applications/"Zalo Recorder.app"/Contents/MacOS/zalo-recorder --status
   ```
7. **Acceptance Criteria**:
   - Microphone: `GRANTED`
   - Screen Recording: `GRANTED`
   - Accessibility: `GRANTED`
   - Loopback Server: `HEALTHY`
   - CRM Heartbeat: `permissions_ok = true`, status `ONLINE`
   - No user prompts or dialogs triggered.
