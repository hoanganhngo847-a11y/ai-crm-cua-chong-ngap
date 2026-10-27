import Foundation
import CoreAudio
import ApplicationServices
import CoreGraphics
import AppKit
import AVFoundation

struct Config {
    static let outputDirectory = ProcessInfo.processInfo.environment["ZALO_RECORDINGS_DIR"]
        ?? NSString(string: "~/Movies/ZaloCalls").expandingTildeInPath
    static let tempDirectory = ProcessInfo.processInfo.environment["ZALO_RECORDINGS_TEMP_DIR"]
        ?? NSString(string: "~/.zalo_recordings_temp").expandingTildeInPath
    static let legacyOutputUID = "org.antigravity.multioutput"
    static let fallbackOutputUID = "BuiltInSpeakerDevice"
    static let liveVoiceEnabled = ProcessInfo.processInfo.environment["ZALO_PERSONAL_LIVE_VOICE_ENABLED"] == "1"
    static let inboundAutoAnswerEnabled = ProcessInfo.processInfo.environment["ZALO_PERSONAL_LIVE_VOICE_AUTO_ANSWER"] == "1"
    static let liveVoiceOutputUID = ProcessInfo.processInfo.environment["ZALO_VOICE_OUTPUT_UID"] ?? ""
    static let liveVoiceModel = ProcessInfo.processInfo.environment["GEMINI_LIVE_MODEL"] ?? "gemini-2.5-flash-native-audio-preview-12-2025"
    static let liveVoiceApiVersion = ProcessInfo.processInfo.environment["GEMINI_LIVE_API_VERSION"] ?? "v1alpha"
}

// Routing is read-only during calls. The only write is migration away from the
// exact legacy Multi-Output UID, and only when it is still selected. Recheck
// while idle because macOS can fall back to it when headphones disconnect.
final class AudioManager {
    static let shared = AudioManager()
    private let system = AudioObjectID(kAudioObjectSystemObject)

    func uid(for device: AudioObjectID) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<CFString?>.size)
        var value: CFString?
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr else { return nil }
        return value as String?
    }

    func defaultUID(_ selector: AudioObjectPropertySelector = kAudioHardwarePropertyDefaultOutputDevice) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var device: AudioObjectID = 0
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &device) == noErr else { return nil }
        return uid(for: device)
    }

    func devices() -> [AudioObjectID] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return [] }
        var devices = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &devices) == noErr else { return [] }
        return devices
    }

    func repairLegacyOutput() throws {
        // Preserve any currently selected headphones/USB/Bluetooth device.
        for selector in [kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDefaultSystemOutputDevice] {
            guard defaultUID(selector) == Config.legacyOutputUID else { continue }
            guard var target = devices().first(where: { uid(for: $0) == Config.fallbackOutputUID }) else {
                throw RecorderFailure(message: "Select a physical speaker/headphone output in Sound settings; legacy output remains selected.")
            }
            var address = AudioObjectPropertyAddress(mSelector: selector,
                mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            let status = AudioObjectSetPropertyData(system, &address, 0, nil,
                UInt32(MemoryLayout<AudioObjectID>.size), &target)
            guard status == noErr else { throw RecorderFailure(message: "Cannot restore physical output: \(status)") }
            print("[Routing] Replaced legacy Multi-Output with built-in speakers.")
        }
    }
}

// MARK: - Zalo Call State Detector (Pure In-Memory Native API)

struct ZaloProbeResult {
    let isActive: Bool
    let contactName: String?
    let direction: CallDirection
}

class ZaloDetector {
    static let shared = ZaloDetector()

    func getZaloCallPID() -> pid_t? {
        for app in NSWorkspace.shared.runningApplications {
            if app.localizedName == "ZaloCall" {
                return app.processIdentifier
            }
        }
        for app in NSWorkspace.shared.runningApplications {
            if app.bundleIdentifier == "com.vng.zalo.zalocall" && app.localizedName != "ZaloCap" {
                return app.processIdentifier
            }
        }
        return nil
    }

    func probe() -> ZaloProbeResult {
        // Incoming personal calls are shown as an accessibility invite in the
        // main Zalo app before the separate ZaloCall process/window exists.
        // Detect that invite first so auto-answer can run while it is ringing and
        // capture the caller name before the invite disappears.
        let incoming = ZaloAutomation.shared.incomingVoiceCallInfo()
        if incoming.detected {
            return ZaloProbeResult(
                isActive: true,
                contactName: RemoteDisplayName.specific(incoming.callerName),
                direction: .inbound
            )
        }

        guard let pid = getZaloCallPID() else {
            return ZaloProbeResult(isActive: false, contactName: nil, direction: .unknown)
        }

        let options = CGWindowListOption(arrayLiteral: .excludeDesktopElements, .optionOnScreenOnly)
        var hasCallWindow = false
        var windowTitle: String? = nil

        if let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] {
            for win in list {
                let ownerPID = win[kCGWindowOwnerPID as String] as? Int32 ?? 0
                let owner = win[kCGWindowOwnerName as String] as? String ?? ""
                let bounds = win[kCGWindowBounds as String] as? [String: Any] ?? [:]
                let w = bounds["Width"] as? Int ?? 0
                let h = bounds["Height"] as? Int ?? 0

                if ownerPID == pid || owner == "ZaloCall" {
                    if w >= 120 && h >= 120 {
                        hasCallWindow = true
                        if let name = win[kCGWindowName as String] as? String, !name.isEmpty {
                            windowTitle = RemoteDisplayName.retaining(windowTitle, observed: name)
                        }
                    }
                }
            }
        }

        if !hasCallWindow {
            return ZaloProbeResult(isActive: false, contactName: nil, direction: .unknown)
        }

        let appAx = AXUIElementCreateApplication(pid)
        var winsRef: CFTypeRef?
        var foundTexts: [String] = []

        if AXUIElementCopyAttributeValue(appAx, kAXWindowsAttribute as CFString, &winsRef) == .success,
           let windows = winsRef as? [AXUIElement] {
            for win in windows {
                var titleRef: CFTypeRef?
                if AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &titleRef) == .success,
                   let t = titleRef as? String, !t.isEmpty {
                    windowTitle = RemoteDisplayName.retaining(windowTitle, observed: t)
                }
                collectStaticTexts(element: win, texts: &foundTexts, depth: 0, maxDepth: 2)
            }
        }

        let contactName = RemoteDisplayName.specific(windowTitle)

        let direction = CallDirection.observed(foundTexts)

        return ZaloProbeResult(
            isActive: hasCallWindow,
            contactName: contactName,
            direction: direction
        )
    }

    private func collectStaticTexts(element: AXUIElement, texts: inout [String], depth: Int, maxDepth: Int) {
        if depth > maxDepth { return }
        var valRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &valRef) == .success,
           let val = valRef as? String, !val.isEmpty {
            texts.append(val)
        }
        var titleRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &titleRef) == .success,
           let t = titleRef as? String, !t.isEmpty {
            texts.append(t)
        }
        var childrenRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
           let children = childrenRef as? [AXUIElement] {
            for child in children {
                collectStaticTexts(element: child, texts: &texts, depth: depth + 1, maxDepth: maxDepth)
            }
        }
    }
}

// MARK: - Recorder lifecycle

final class CallRecorder {
    let callID: String
    let directory: URL
    let startedAt = Date()
    let capture: NativeCallCapture
    private var endedAt: Date?
    var boundOutboundContext: PendingOutboundContext?
    var liveVoiceBridge: LiveVoiceBridge?

    init(callID: String) throws {
        self.callID = callID
        directory = URL(fileURLWithPath: Config.tempDirectory).appendingPathComponent(callID)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        capture = NativeCallCapture(directory: directory)
    }

    func stop(completion: @escaping (String?) -> Void) {
        endedAt = Date()
        capture.onRemotePCM16 = nil
        liveVoiceBridge?.stop()
        capture.stop(completion: completion)
    }

    func finalize(contact: String?, direction: CallDirection, captureError: String?) throws -> String {
        let end = endedAt ?? Date()
        let duration = end.timeIntervalSince(startedAt)
        let finalizer = RecordingFinalizer()
        let remote = directory.appendingPathComponent("remote.wav").path
        let local = directory.appendingPathComponent("local.wav").path
        let remoteLevels = try finalizer.levels(remote)
        let localLevels = try finalizer.levels(local)
        let output = URL(fileURLWithPath: Config.outputDirectory)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd'T'HHmmss"
        let stem = "zalo_\(formatter.string(from: startedAt))_\(callID)"
        let recording = output.appendingPathComponent(stem + ".m4a")
        let actualDuration = try finalizer.merge(remote: remote, local: local,
                                                 destination: recording.path, duration: duration)
        let status: String
        if captureError != nil {
            status = "WARNING_CAPTURE_ERROR"
        } else if remoteLevels.nonSilent && localLevels.nonSilent {
            status = "SIGNAL_PRESENT_BOTH_TRACKS"
        } else if !remoteLevels.nonSilent && !localLevels.nonSilent {
            status = "WARNING_BOTH_TRACKS_SILENT"
        } else {
            status = "WARNING_ONE_TRACK_SILENT"
        }
        var crmCallRequestId: String? = nil
        var effectiveDirection = direction
        if let ctx = boundOutboundContext {
            effectiveDirection = .outbound
            crmCallRequestId = ctx.requestId
        }

        let iso = ISO8601DateFormatter()
        var metadata = CallMetadata(id: callID, device_id: try AgentIdentity.deviceID(), direction: effectiveDirection,
            started_at: iso.string(from: startedAt), ended_at: iso.string(from: end),
            duration_seconds: actualDuration, remote_display_name: contact,
            recording_path: recording.path,
            remote_track_present: capture.remote.statistics.received_frames > 0,
            local_track_present: capture.local.statistics.received_frames > 0,
            capture_error: captureError, remote_timing: capture.remote.statistics,
            local_timing: capture.local.statistics,
            audio_validation: AudioValidation(remote_non_silent: remoteLevels.nonSilent,
                local_non_silent: localLevels.nonSilent, duration: actualDuration,
                remote_peak_db: remoteLevels.peak_db, remote_mean_db: remoteLevels.mean_db,
                local_peak_db: localLevels.peak_db, local_mean_db: localLevels.mean_db, status: status))
        metadata.crm_call_request_id = crmCallRequestId
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(metadata).write(to: output.appendingPathComponent(stem + ".json"), options: .atomic)
        if status == "SIGNAL_PRESENT_BOTH_TRACKS" {
            try FileManager.default.removeItem(at: directory)
        } else {
            print("[Warning] \(status). Raw tracks retained: \(directory.path)")
        }
        return recording.path
    }
}

enum CallState: String {
    case idle = "Waiting for call"
    case starting = "Starting capture"
    case recording = "Capturing app audio + microphone"
    case failed = "Capture error - waiting for call to close"
    case finalizing = "Finalizing file"
}

final class ZaloAgent {
    private var state: CallState = .idle
    private var recorder: CallRecorder?
    private var contact: String?
    private var direction: CallDirection = .unknown
    private var inactiveCount = 0
    private var signals: [DispatchSourceSignal] = []
    private var timer: Timer?
    private var stopping = false
    private var lastStatus = ""
    private var lockFD: Int32 = -1
    private var lastError: String?
    private var lastRoutingError: String?
    private var loopbackServer: LoopbackServer?
    private var inboundAnswerAttempts = 0

    func start() throws {
        // Prevent two new agents from recording the same call.
        lockFD = open("/tmp/zalo-recorder-\(getuid()).lock", O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
            throw RecorderFailure(message: "Another Zalo recorder is already running.")
        }
        try AudioManager.shared.repairLegacyOutput()
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.shutdown() }
            source.resume()
            signals.append(source)
        }
        print("Zalo Recorder: native app-audio capture; no BlackHole/Multi-Output routing.")
        print("In Zalo Call, select a physical speaker/headphone or System Default, not Multi-Output/BlackHole.")
        print("Files: \(Config.outputDirectory)")
        NSApplication.shared.setActivationPolicy(.accessory)
        let perm = PermissionManager.shared.snapshot()
        if !perm.accessibility {
            print("[Permission] Accessibility is ungranted: caller name/direction may be unknown. Run with --setup-permissions to configure.")
        }
        RecordingUploadQueue.shared.start(recordings: URL(fileURLWithPath: Config.outputDirectory))

        // Start loopback HTTP server for CRM web app
        let server = LoopbackServer()
        server.onCallRequest = { reqId in
            OutboundCallManager.shared.executeOutboundCall(requestId: reqId)
        }
        do {
            try server.start()
            loopbackServer = server
        } catch {
            print("[LoopbackServer Warning] \(error.localizedDescription)")
        }

        // Start periodic heartbeat
        HeartbeatManager.shared.start(intervalSeconds: 30)

        // Register custom URL scheme handler
        URLSchemeHandler.shared.register()

        timer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in self?.tick() }
        tick()
        RunLoop.main.run()
    }

    private func tick() {
        guard !stopping, state != .finalizing else { return }
        if state == .idle {
            do {
                try AudioManager.shared.repairLegacyOutput()
                lastRoutingError = nil
            } catch {
                if lastRoutingError != error.localizedDescription {
                    print("[Routing warning] \(error.localizedDescription)")
                    lastRoutingError = error.localizedDescription
                }
            }
        }
        let probe = ZaloDetector.shared.probe()
        if probe.isActive {
            inactiveCount = 0
            contact = RemoteDisplayName.retaining(contact, observed: probe.contactName)
            if probe.direction == .inbound {
                direction = .inbound
            } else if direction == .unknown {
                direction = probe.direction
            }
            // An incoming Zalo window can expose no direction label until after
            // it is answered. Try only when it is not positively identified as
            // outbound; the AX walker itself still requires an unambiguous
            // answer/accept button before clicking anything.
            if state == .idle && Config.inboundAutoAnswerEnabled && direction != .outbound {
                if ZaloAutomation.shared.acceptIncomingVoiceCall() {
                    direction = .inbound
                    print("[Inbound] Accepted incoming Zalo call from '\(contact ?? "unknown")'.")
                    inboundAnswerAttempts = 0
                } else {
                    inboundAnswerAttempts += 1
                    if inboundAnswerAttempts == 5 {
                        print("[Inbound] Could not find an unambiguous Zalo answer button; call was not auto-accepted.")
                    }
                }
            }
            checkAndBindOutbound()
            if state == .idle && !(Config.inboundAutoAnswerEnabled && direction != .outbound && inboundAnswerAttempts >= 5) {
                begin()
            }
        } else if state != .idle {
            // Grace period: allow at least 6 seconds for the ZaloCall window to establish and stabilize
            let callAge = recorder.map { Date().timeIntervalSince($0.startedAt) } ?? 0
            if callAge < 6.0 {
                inactiveCount = 0
            } else {
                inactiveCount += 1
                if inactiveCount >= 15 { finish() }
            }
        }
        let status = "[\(state.rawValue)] Contact: \(contact ?? "unknown") | Output: \(AudioManager.shared.defaultUID() ?? "unknown")"
        if status != lastStatus { print(status); lastStatus = status }
    }

    private func checkAndBindOutbound() {
        guard let rec = recorder else { return }
        if let bound = OutboundCallManager.shared.bindOutboundContext(
            callID: rec.callID,
            contactName: contact,
            direction: direction,
            startedAt: rec.startedAt
        ) {
            if rec.boundOutboundContext == nil {
                rec.boundOutboundContext = bound
                print("[Outbound] Early bound call \(rec.callID) with CRM request \(bound.requestId) for '\(bound.customerName)'")
                OutboundCallManager.shared.notifyCallDetectedAsync(requestId: bound.requestId)
                startLiveVoice(for: rec, context: bound)
            }
        } else if rec.boundOutboundContext != nil {
            print("[Outbound] Invalidation detected for call \(rec.callID). Clearing bound context.")
            rec.boundOutboundContext = nil
        }
    }

    private func startLiveVoice(for recorder: CallRecorder, context: PendingOutboundContext) {
        guard Config.liveVoiceEnabled else { return }
        guard recorder.liveVoiceBridge == nil else { return }
        guard let config = UploadConfiguration.load() else {
            print("[LiveVoice] Disabled: local agent is not enrolled.")
            return
        }
        do {
            let bridge = try LiveVoiceBridge(requestId: context.requestId, localCallId: recorder.callID,
                                             config: config, outputUID: Config.liveVoiceOutputUID)
            recorder.liveVoiceBridge = bridge
            recorder.capture.onRemotePCM16 = { [weak bridge] data in bridge?.sendInputPCM16(data) }
            bridge.start()
            print("[LiveVoice] Starting CRM-scoped Zalo voice bridge for customer '\(context.customerName)'.")
        } catch {
            print("[LiveVoice] Disabled for this call: \(error.localizedDescription)")
        }
    }

    private func begin() {
        do {
            let recorder = try CallRecorder(callID: UUID().uuidString.lowercased())
            self.recorder = recorder
            OutboundCallManager.shared.registerActiveSession(callID: recorder.callID)
            state = .starting
            recorder.capture.onFailure = { [weak self] message in
                DispatchQueue.main.async {
                    self?.lastError = message
                    print("[Capture error] \(message)")
                }
            }
            checkAndBindOutbound()
            recorder.capture.start { [weak self, weak recorder] result in
                DispatchQueue.main.async {
                    guard let self = self, let recorder = recorder, self.recorder === recorder,
                          self.state == .starting else { return }
                    switch result {
                    case .success:
                        self.state = .recording
                        if self.direction == .inbound && Config.liveVoiceEnabled {
                            self.startInboundLiveVoice(for: recorder, remoteDisplayName: self.contact)
                        }
                    case .failure(let error):
                        self.lastError = error.localizedDescription
                        self.state = .failed
                        print("[Capture failed] \(error.localizedDescription)")
                        print("Check Screen & System Audio Recording and Microphone permissions for the launching app.")
                    }
                }
            }
        } catch {
            state = .failed
            lastError = error.localizedDescription
            print("[Capture failed] \(error.localizedDescription)")
        }
    }

    private func startInboundLiveVoice(for recorder: CallRecorder, remoteDisplayName: String?) {
        guard recorder.liveVoiceBridge == nil else { return }
        guard let config = UploadConfiguration.load() else {
            print("[LiveVoice] Inbound disabled: local agent is not enrolled.")
            return
        }
        do {
            let bridge = try LiveVoiceBridge(localCallId: recorder.callID,
                                             remoteDisplayName: remoteDisplayName,
                                             config: config, outputUID: Config.liveVoiceOutputUID)
            recorder.liveVoiceBridge = bridge
            recorder.capture.onRemotePCM16 = { [weak bridge] data in bridge?.sendInputPCM16(data) }
            bridge.start()
            print("[LiveVoice] Starting company-context inbound voice bridge.")
        } catch {
            print("[LiveVoice] Inbound disabled for this call: \(error.localizedDescription)")
        }
    }

    private func finish() {
        state = .finalizing
        guard let recorder = recorder else { reset(); return }
        let savedContact = contact
        let savedDirection = direction
        let savedError = lastError
        let closingCallID = recorder.callID
        recorder.stop { error in
            DispatchQueue.global(qos: .utility).async {
                defer { OutboundCallManager.shared.releaseSession(callID: closingCallID) }
                do {
                    let path = try recorder.finalize(contact: savedContact, direction: savedDirection,
                                                     captureError: error ?? savedError)
                    print("[Saved] \(path)")
                    RecordingUploadQueue.shared.enqueue(path)
                } catch {
                    print("[NOT SAVED] \(error.localizedDescription)")
                    print("[Recovery] Raw tracks/log retained: \(recorder.directory.path)")
                    let message = "\(error.localizedDescription)\nCapture: \(savedError ?? "none")\n"
                    try? message.write(to: recorder.directory.appendingPathComponent("failure.txt"), atomically: true, encoding: .utf8)
                }
                DispatchQueue.main.async {
                    self.reset()
                    if self.stopping { exit(0) }
                }
            }
        }
    }

    private func reset() {
        if let rec = recorder { OutboundCallManager.shared.releaseSession(callID: rec.callID) }
        recorder = nil
        contact = nil
        direction = .unknown
        inactiveCount = 0
        lastError = nil
        inboundAnswerAttempts = 0
        state = .idle
        if stopping { exit(0) }
    }

    private func shutdown() {
        guard !stopping else { return }
        stopping = true
        timer?.invalidate()
        HeartbeatManager.shared.stop()
        loopbackServer?.stop()
        print("[Shutdown] Closing native capture and finalizing active recording...")
        if state == .finalizing { return }
        if recorder != nil { finish() } else { exit(0) }
    }
}

final class URLSchemeHandler: NSObject {
    static let shared = URLSchemeHandler()

    func register() {
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleGetURL(event:withReplyEvent:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    @objc func handleGetURL(event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        guard let urlString = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
              let url = URL(string: urlString),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        if let requestId = components.queryItems?.first(where: { $0.name == "request_id" })?.value {
            print("[URLScheme] Received call request: \(requestId)")
            DispatchQueue.global(qos: .userInitiated).async {
                OutboundCallManager.shared.executeOutboundCall(requestId: requestId)
            }
        }
    }
}

setbuf(stdout, nil)
do {
    if CommandLine.arguments.contains("--new-account-context") {
        try withAgentConfigurationLock { try AgentIdentity.newAccountContext() }
    } else if CommandLine.arguments.contains("--device-id") {
        print(try AgentIdentity.deviceID())
    } else if CommandLine.arguments.contains("--configure-upload") {
        try withAgentConfigurationLock { try UploadConfiguration.configure() }
    } else if CommandLine.arguments.contains("--retry-uploads") {
        try withAgentConfigurationLock { try RecordingUploadQueue.shared.retryPending() }
    } else if CommandLine.arguments.contains("--send-heartbeat") {
        print("[CLI] Sending manual heartbeat...")
        let sem = DispatchSemaphore(value: 0)
        HeartbeatManager.shared.sendHeartbeat { success, msg in
            if success {
                print("[CLI] Heartbeat sent successfully!")
            } else {
                print("[CLI] Heartbeat failed: \(msg ?? "unknown")")
            }
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 5)
    } else if CommandLine.arguments.contains("--setup-permissions") {
        print("=== Zalo Personal Recording Agent: Permission Setup ===")
        print("Running bundle: \(Bundle.main.bundleIdentifier ?? "standalone-binary")")
        print("Executable: \(Bundle.main.executablePath ?? CommandLine.arguments[0])")
        let sem = DispatchSemaphore(value: 0)
        var finalSnapshot: PermissionSnapshot?
        PermissionManager.shared.performUserSetup { snapshot in
            finalSnapshot = snapshot
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 10)
        if let s = finalSnapshot, s.isAllGranted {
            exit(0)
        } else {
            exit(1)
        }
    } else if CommandLine.arguments.contains("--status") {
        let lockFD = open("/tmp/zalo-recorder-\(getuid()).lock", O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        let isRunning = lockFD >= 0 && flock(lockFD, LOCK_EX | LOCK_NB) != 0
        if lockFD >= 0 { close(lockFD) }

        print("=== Zalo Personal Recording Agent ===")
        print("Agent Version: 1.2.0")
        let devId = (try? AgentIdentity.deviceID()) ?? "uninitialized"
        print("Device ID: \(devId)")
        if let config = UploadConfiguration.load() {
            print("Configured CRM: \(config.server_url.absoluteString)")
            print("Enrolled At: \(config.enrolled_at)")
        } else {
            print("Configured CRM: Not configured (run --configure-upload)")
        }
        print("Agent Process: \(isRunning ? "RUNNING" : "STOPPED")")

        // Permissions summary
        let perm = PermissionManager.shared.snapshot()
        print("Permissions:")
        print("  - Microphone: \(perm.microphone == .authorized ? "GRANTED" : "DENIED")")
        print("  - Screen Recording: \(perm.screenRecording ? "GRANTED" : "DENIED")")
        print("  - Accessibility: \(perm.accessibility ? "GRANTED" : "DENIED")")

        let probe = ZaloDetector.shared.probe()
        let runningApps = NSWorkspace.shared.runningApplications
        let zaloRunning = runningApps.contains { app in
            app.bundleIdentifier == "com.vng.zalo" || app.localizedName == "Zalo"
        }
        print("Zalo Desktop: \(zaloRunning ? "RUNNING" : "NOT RUNNING")")
        print("Active Call Window: \(probe.isActive ? "YES" : "NO")")

        // Check Loopback health
        if isRunning {
            let url = URL(string: "http://127.0.0.1:48123/health")!
            let sem = DispatchSemaphore(value: 0)
            var loopbackOk = false
            var loopbackMsg = "timeout"
            let task = URLSession.shared.dataTask(with: url) { data, resp, err in
                if let http = resp as? HTTPURLResponse, http.statusCode == 200, let data = data,
                   let str = String(data: data, encoding: .utf8) {
                    loopbackOk = true
                    loopbackMsg = str
                } else if let err = err {
                    loopbackMsg = err.localizedDescription
                }
                sem.signal()
            }
            task.resume()
            _ = sem.wait(timeout: .now() + 1.5)
            print("Loopback Server (127.0.0.1:48123): \(loopbackOk ? "HEALTHY (\(loopbackMsg))" : "UNHEALTHY (\(loopbackMsg))")")
        } else {
            print("Loopback Server: OFFLINE")
        }
    } else if CommandLine.arguments.contains("--diagnose") {
        let audio = AudioManager.shared
        print("Output: \(audio.defaultUID() ?? "unknown")")
        print("Input: \(audio.defaultUID(kAudioHardwarePropertyDefaultInputDevice) ?? "unknown")")
        print("Legacy route selected: \(audio.defaultUID() == Config.legacyOutputUID)")
        let perm = PermissionManager.shared.snapshot()
        print("Microphone authorization: \(perm.microphone.rawValue)")
        print("Screen capture preflight: \(perm.screenRecording)")
        print("Accessibility: \(perm.accessibility)")
        let probe = ZaloDetector.shared.probe()
        print("Call window visible: \(probe.isActive)")
        print("Devices: \(audio.devices().compactMap { audio.uid(for: $0) }.joined(separator: ", "))")
    } else if CommandLine.arguments.contains("--audio-devices") {
        for device in AudioManager.shared.devices() {
            print(AudioManager.shared.uid(for: device) ?? "unknown")
        }
    } else if CommandLine.arguments.contains("--check-capture") {
        // Explicit user-operated, bounded permission/smoke test; makes no call.
        let before = AudioManager.shared.defaultUID()
        let recorder = try CallRecorder(callID: "check-" + String(UUID().uuidString.prefix(8)).lowercased())
        print("[Check] Recording Zalo app audio and microphone for 5 seconds after permission is granted.")
        print("[Check] Speak a few words; Zalo can remain idle (remote silence is then expected).")
        recorder.capture.start { result in
            switch result {
            case .failure(let error):
                recorder.stop { _ in
                    fputs("[Check failed] \(error.localizedDescription)\n", stderr)
                    exit(1)
                }
            case .success:
                DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                    recorder.stop { error in
                        do {
                            let path = try recorder.finalize(contact: nil, direction: .unknown, captureError: error)
                            print("[Check saved] \(path)")
                            guard before == AudioManager.shared.defaultUID() else {
                                throw RecorderFailure(message: "Output route changed during check (possibly by another app).")
                            }
                            print("[Check] Output route preserved. Review companion JSON for actual track signal.")
                            exit(error == nil ? 0 : 1)
                        } catch {
                            fputs("[Check failed] \(error.localizedDescription)\nRaw tracks: \(recorder.directory.path)\n", stderr)
                            exit(1)
                        }
                    }
                }
            }
        }
        RunLoop.main.run()
    } else if CommandLine.arguments.contains("--repair-output") {
        try AudioManager.shared.repairLegacyOutput()
        print("Output: \(AudioManager.shared.defaultUID() ?? "unknown")")
    } else if CommandLine.arguments.contains("--call") {
        var requestId: String? = nil
        let args = CommandLine.arguments
        for i in 0..<args.count {
            if (args[i] == "--call" || args[i] == "--request-id") && i + 1 < args.count {
                let candidate = args[i + 1]
                if !candidate.hasPrefix("-") && UUID(uuidString: candidate) != nil {
                    requestId = candidate
                }
            }
        }
        guard let id = requestId else {
            fputs("Usage: zalo-recorder --call <request_id>\n", stderr)
            exit(1)
        }
        print("[CLI] Executing outbound call for request \(id)...")
        OutboundCallManager.shared.executeOutboundCall(requestId: id)
    } else {
        try ZaloAgent().start()
    }
} catch {
    fputs("[Fatal] \(error.localizedDescription)\n", stderr)
    exit(1)
}
