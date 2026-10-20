# Zalo recorder on macOS

## CRM upload (v2)

Recording is independent of Stringee and OBS. Upload uses a separate revocable
device credential; it never uses the browser session or a Supabase service key.

1. Stop the recorder between calls. Run `bash local-agent/run.sh --device-id`.
2. As an authorized Boss in CRM, open **Calls > Thiết bị ghi âm Zalo**. Register
   that UUID and choose the actual staff member, or leave it as a shared machine.
   Shared-machine recordings are visible only to Boss until staff context exists.
3. Run `bash local-agent/run.sh --configure-upload` in Terminal. Enter the CRM
   HTTPS origin and the one-time device secret at the hidden prompt. The secret
   is stored in macOS Keychain; the server stores only its SHA-256 hash.
4. Start `bash local-agent/run.sh`. Only recordings started after enrollment
   upload automatically. Older recordings are retained without automatic import.

Queue state is under `~/Library/Application Support/ZaloRecordingAgent/queue/`.
Transitions: `RECORDED -> QUEUED -> UPLOADING -> SERVER_CONFIRMED`, or
`RETRY_PENDING`. JSON writes are atomic; restart recovers pending work and scans
finalized version-1 metadata to recover a finalize/enqueue crash. A corrupt queue
file is preserved and reconstructed from the companion JSON. Retries use 5 s
exponential backoff, capped at one hour and 12 attempts; permanent 4xx failures
pause that entry. Stop the agent and use `--retry-uploads` after correcting auth,
network or file problems. Server idempotency preserves the same call UUID.

Keep one declared Zalo account per registration. After all pending uploads finish,
stop the agent, revoke the old device in CRM and run `--new-account-context`.
Register the new UUID and configure upload before recording the other account.
This context is not an observed Zalo UID. Account switching is not detectable
through public Accessibility APIs; do not reuse a context across accounts.

The endpoint accepts at most 50 MiB and 2 hours, independently; a long 192-kbit/s
recording can hit the byte limit before two hours. Oversized recordings remain
local and need explicit follow-up. HTTPS is required except for localhost tests.
Redirects are rejected so credentials cannot follow another origin.

Companion JSON retains original/specific display name, explicit unknown answer
time/phone, full session UUID, device UUID and agent version. The first specific
name survives generic connected-window titles. Connecting labels do not infer
direction. Upload transmits an explicit metadata allowlist and the M4A; it excludes
local paths, debug timing/capture details and any Zalo chat/session material.

CRM adds independent `ZALO_PERSONAL` / `LOCAL_AGENT` call history, private audio,
name suggestions and manual customer confirmation. Display names never become
Zalo UIDs. Known duplicates or contradictory confirmations disable automatic reuse.
No transcription, OpenAI request or AI job is created for these calls. Recordings
and companion JSON are never deleted after upload in this version.

See [CRM operations and acceptance](../docs/ZALO_PERSONAL_RECORDINGS.md).

The recorder captures Zalo application audio with ScreenCaptureKit and the current
default microphone with AVCaptureSession. It does not route playback through
BlackHole or Multi-Output. macOS 13+, Apple Silicon, Swift command-line tools and
`/opt/homebrew/bin/ffmpeg` / `ffprobe` are required.

## Start

1. Stop the previous recorder before running this version. Do this between calls;
   the old recorder's termination handler may restore the built-in speakers.
2. In Zalo Call, choose **System Default**, your physical speakers, or headphones
   for output. Choose the same physical microphone as macOS Sound settings.
   Zalo can remember a per-app device selection, so changing the system default
   alone does not prove that Zalo stopped using Multi-Output/BlackHole.
3. Run from Terminal in the repository:

   ```sh
   bash local-agent/run.sh --check-capture
   ```

   This records app audio and microphone for five seconds after authorization.
   macOS may ask for **Microphone** and **Screen & System Audio Recording** access
   for the recorder or launching application. The owner must approve these
   permissions in System Settings > Privacy & Security, then restart the command
   if macOS requests it. ScreenCaptureKit needs the screen/audio permission even
   though this recorder registers only an audio output and saves no video.
   With no sound playing in Zalo, a silent remote track warning is expected;
   this test alone does not establish that real call audio is captured.
4. Start normal detection:

   ```sh
   bash local-agent/run.sh
   ```

   Leave Terminal running. Ctrl+C closes capture, finalizes the current file and
   exits. The new agent keeps the selected system output on startup, calls and
   shutdown. The exception is migration from the exact old
   `org.antigravity.multioutput` UID to built-in speakers, if still selected.
   This is checked at startup and while idle, including after headphones
   disconnect and macOS falls back to the old device.
   It does not remove any installed audio devices or drivers.

Read-only diagnostics:

```sh
bash local-agent/run.sh --diagnose
```

This prints device UIDs, microphone authorization, screen-capture preflight,
Accessibility trust and call-window detection. It does not request permissions
or start recording. A sandbox may hide devices and deny access independently of
the machine's actual settings; run the recorder from Terminal for real capture.
Accessibility is used for the contact/direction. A visible call window starts
capture; it does not establish whether the call was answered. `answered_at` is
therefore unknown, and name/direction may also be unknown without that access.
Window detection retains the original on-screen behavior; a minimized/hidden
call window can end a recording. That detector limitation is separate from the
audio-routing repair.

## Files and validation

Final files go to `~/Movies/ZaloCalls/`: stereo M4A (left = Zalo remote audio,
right = local microphone), plus JSON metadata. Native samples are mapped to a
shared host-clock origin. Missing intervals are padded and overlapping/preroll
samples are trimmed. Timing counters appear in the JSON.

The finalizer accepts mono or stereo remote input, resamples to 48 kHz, leaves
headroom without limiter make-up gain, pads both tracks to the call duration,
checks the stereo format/duration and decodes the whole M4A before publishing.
Raw float peaks are measured with `astats`, which can detect values above 0 dBFS.
Signal detection is **not** a claim about intelligibility or AEC performance.

Missing audio, capture failures and failed merges do not produce a success
message. Raw tracks stay under `~/.zalo_recordings_temp/<call-id>/`; finalization
failures also leave `failure.txt`. Silent/capture-warning sessions retain raw
tracks even when an M4A was successfully produced. Only successful sessions
with signal on both sides remove their temporary input directory.

`ZALO_RECORDINGS_DIR` and `ZALO_RECORDINGS_TEMP_DIR` can override these paths.
The app audio allowlist is `com.vng.zalo` and its sub-bundles. If Zalo is absent
from the application list, capture fails rather than recording all applications.
An AudioService restart/app-family attribution change still needs live testing.

## Build and tests

```sh
BUILD_ONLY=1 bash local-agent/run.sh
bash local-agent/tests/run.sh
bash -n local-agent/run.sh local-agent/tests/run.sh
plutil -lint local-agent/Info.plist
```

Regression tests use generated files, not real calls or microphone access.
They check channel identity, mono/stereo sources, unequal lengths, decoded AAC
headroom, float peaks, silence, failed-merge preservation, timestamp gaps,
overlaps, preroll and the application allowlist. AVFoundation file conversion
can be denied in a restricted sandbox; run the file-only tests unsandboxed.
The scripts compile to a temporary directory and replace the binary only after
a successful build. The local signature/embedded usage descriptions do not
grant macOS recording permissions.

## Real acceptance still required

After permission and device setup, make a short call in which both participants
speak. Verify clear playback through the selected physical device, normal volume
control, both decoded channels and the companion JSON. Repeat with headphones
and speakers if both modes are required. Do not treat a headphone-only result as
proof of the exact speaker/AEC failure cause. This code does not promise hardware
AEC behavior; it removes the recorder's forced Multi-Output routing.

Apple references: [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit),
[app-level audio capture](https://developer.apple.com/videos/play/wwdc2022/10155/),
[capturesAudio](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio).
