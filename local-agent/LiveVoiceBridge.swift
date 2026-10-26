import Foundation
import CoreAudio
import AudioToolbox

final class LiveVoicePCMOutput {
    private let lock = NSLock()
    private let channels = 2
    private var ring: [Float]
    private var readIndex = 0
    private var writeIndex = 0
    private var sampleCount = 0

    init(seconds: Int = 12, sampleRate: Int = 48_000) {
        ring = Array(repeating: 0, count: max(1, seconds * sampleRate * channels))
    }

    func appendPCM24kMono(_ data: Data) {
        let sampleCount = data.count / MemoryLayout<Int16>.size
        guard sampleCount > 0 else { return }
        data.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            lock.lock()
            for index in 0..<samples.count {
                let value = Float(samples[index]) / 32768.0
                // Gemini Live returns 24 kHz mono PCM. The selected virtual device is
                // 48 kHz stereo, so duplicate each frame for a bounded bridge.
                for _ in 0..<2 {
                    for _ in 0..<channels {
                        if self.sampleCount >= self.ring.count {
                            readIndex = (readIndex + channels) % ring.count
                            self.sampleCount -= channels
                        }
                        ring[writeIndex] = value
                        writeIndex = (writeIndex + 1) % ring.count
                        self.sampleCount += 1
                    }
                }
            }
            lock.unlock()
        }
    }

    func render(_ buffers: UnsafeMutableAudioBufferListPointer, frames: Int) {
        lock.lock()
        defer { lock.unlock() }
        guard buffers.count > 0, let destination = buffers[0].mData?.assumingMemoryBound(to: Float.self) else { return }
        let wanted = max(0, frames * channels)
        for index in 0..<wanted {
            if sampleCount > 0 {
                destination[index] = ring[readIndex]
                readIndex = (readIndex + 1) % ring.count
                sampleCount -= 1
            } else {
                destination[index] = 0
            }
        }
        buffers[0].mDataByteSize = UInt32(wanted * MemoryLayout<Float>.size)
    }
}

final class LiveVoiceAudioPlayer {
    private var audioUnit: AudioUnit?
    private let output = LiveVoicePCMOutput()

    func start(deviceUID: String) throws {
        guard let device = Self.devices().first(where: { Self.uid(for: $0) == deviceUID }) else {
            throw RecorderFailure(message: "Configured live voice output device was not found.")
        }
        var description = AudioComponentDescription(
            componentType: kAudioUnitType_Output,
            componentSubType: kAudioUnitSubType_HALOutput,
            componentManufacturer: kAudioUnitManufacturer_Apple,
            componentFlags: 0,
            componentFlagsMask: 0)
        guard let component = AudioComponentFindNext(nil, &description) else {
            throw RecorderFailure(message: "Cannot create macOS audio output component.")
        }
        var unit: AudioUnit?
        try check(AudioComponentInstanceNew(component, &unit), "create live voice audio output")
        guard let unit else { throw RecorderFailure(message: "Live voice audio output is unavailable.") }
        audioUnit = unit

        var enable: UInt32 = 1
        try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO,
            kAudioUnitScope_Output, 0, &enable, UInt32(MemoryLayout<UInt32>.size)), "enable live voice output")
        var disable: UInt32 = 0
        _ = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO,
            kAudioUnitScope_Input, 1, &disable, UInt32(MemoryLayout<UInt32>.size))
        var currentDevice = device
        try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global, 0, &currentDevice, UInt32(MemoryLayout<AudioDeviceID>.size)), "select live voice output device")

        var format = AudioStreamBasicDescription(
            mSampleRate: 48_000,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagsNativeFloatPacked,
            mBytesPerPacket: 8,
            mFramesPerPacket: 1,
            mBytesPerFrame: 8,
            mChannelsPerFrame: 2,
            mBitsPerChannel: 32,
            mReserved: 0)
        try check(AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Input, 0, &format, UInt32(MemoryLayout<AudioStreamBasicDescription>.size)), "set live voice output format")

        var callback = AURenderCallbackStruct(
            inputProc: { refCon, _, _, _, frameCount, ioData in
                guard let ioData else { return noErr }
                let player = Unmanaged<LiveVoiceAudioPlayer>.fromOpaque(refCon).takeUnretainedValue()
                player.output.render(UnsafeMutableAudioBufferListPointer(ioData), frames: Int(frameCount))
                return noErr
            },
            inputProcRefCon: Unmanaged.passUnretained(self).toOpaque())
        try check(AudioUnitSetProperty(unit, kAudioUnitProperty_SetRenderCallback,
            kAudioUnitScope_Input, 0, &callback, UInt32(MemoryLayout<AURenderCallbackStruct>.size)), "set live voice render callback")
        try check(AudioUnitInitialize(unit), "initialize live voice audio output")
        do {
            try check(AudioOutputUnitStart(unit), "start live voice audio output")
        } catch {
            AudioUnitUninitialize(unit)
            AudioComponentInstanceDispose(unit)
            audioUnit = nil
            throw error
        }
    }

    func append(_ data: Data) { output.appendPCM24kMono(data) }

    func stop() {
        guard let unit = audioUnit else { return }
        _ = AudioOutputUnitStop(unit)
        _ = AudioUnitUninitialize(unit)
        _ = AudioComponentInstanceDispose(unit)
        audioUnit = nil
    }

    deinit { stop() }

    private static func devices() -> [AudioDeviceID] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return [] }
        var result = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &result) == noErr else { return [] }
        return result
    }

    private static func uid(for device: AudioDeviceID) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<CFString?>.size)
        var value: CFString?
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr else { return nil }
        return value as String?
    }

    private func check(_ status: OSStatus, _ operation: String) throws {
        guard status == noErr else { throw RecorderFailure(message: "Cannot \(operation): \(status)") }
    }
}

final class LiveVoiceBridge {
    private final class WebSocketDelegate: NSObject, URLSessionWebSocketDelegate {
        private let onOpen: (URLSessionWebSocketTask, String?) -> Void
        private let onClose: (URLSessionWebSocketTask, URLSessionWebSocketTask.CloseCode, Data?) -> Void
        private let onComplete: (URLSessionTask, Error?) -> Void

        init(onOpen: @escaping (URLSessionWebSocketTask, String?) -> Void,
             onClose: @escaping (URLSessionWebSocketTask, URLSessionWebSocketTask.CloseCode, Data?) -> Void,
             onComplete: @escaping (URLSessionTask, Error?) -> Void) {
            self.onOpen = onOpen
            self.onClose = onClose
            self.onComplete = onComplete
        }

        func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                        didOpenWithProtocol protocol: String?) {
            onOpen(webSocketTask, `protocol`)
        }

        func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                        reason: Data?) {
            onClose(webSocketTask, closeCode, reason)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask,
                        didCompleteWithError error: Error?) {
            onComplete(task, error)
        }
    }

    private let requestId: String?
    private let localCallId: String
    private let remoteDisplayName: String?
    private let serverURL: URL
    private let deviceId: String
    private let deviceSecret: String
    private let output = LiveVoiceAudioPlayer()
    private let networkQueue = DispatchQueue(label: "zalo.live-voice.network")
    private let sendQueue = DispatchQueue(label: "zalo.live-voice.send")
    private var socket: URLSessionWebSocketTask?
    private var webSocketSession: URLSession?
    private var webSocketDelegate: WebSocketDelegate?
    private var sessionId: String?
    private var stopped = false
    private var started = false
    private var socketReady = false
    private var pendingInput: [Data] = []
    private let maxPendingInputChunks = 150
    private var failure: String?
    private var audioFramesSentCount = 0

    init(requestId: String? = nil, localCallId: String, remoteDisplayName: String? = nil,
         config: UploadConfiguration, outputUID: String) throws {
        guard UploadConfiguration.validServer(config.server_url) else {
            throw RecorderFailure(message: "Live voice requires a valid HTTPS CRM origin.")
        }
        guard !outputUID.isEmpty else {
            throw RecorderFailure(message: "Set ZALO_VOICE_OUTPUT_UID to the BlackHole 2ch device UID before enabling live voice.")
        }
        self.requestId = requestId
        self.localCallId = localCallId
        self.remoteDisplayName = remoteDisplayName
        self.serverURL = config.server_url
        self.deviceId = config.device_id
        self.deviceSecret = try config.secret()
        try output.start(deviceUID: outputUID)
    }

    func start() {
        networkQueue.async { [weak self] in self?.openSession() }
    }

    func sendInputPCM16(_ data: Data) {
        guard !data.isEmpty else { return }
        sendQueue.async { [weak self] in
            guard let self, !self.stopped else { return }
            guard self.socketReady, let socket = self.socket else {
                if self.pendingInput.count < self.maxPendingInputChunks {
                    self.pendingInput.append(data)
                }
                return
            }
            self.sendInputFrame(data, on: socket)
        }
    }

    private func sendInputFrame(_ data: Data, on socket: URLSessionWebSocketTask) {
        let event: [String: Any] = [
            "realtimeInput": [
                "audio": [
                    "data": data.base64EncodedString(),
                    "mimeType": "audio/pcm;rate=16000"
                ]
            ]
        ]
        guard let json = try? JSONSerialization.data(withJSONObject: event),
              let text = String(data: json, encoding: .utf8) else { return }
        socket.send(.string(text)) { [weak self] error in
            guard let self else { return }
            if let error {
                let ns = error as NSError
                self.fail("WebSocket audio send failed: domain=\(ns.domain), code=\(ns.code), description=\(error.localizedDescription)")
            } else {
                self.audioFramesSentCount += 1
                if self.audioFramesSentCount == 1 {
                    print("[LiveVoice] Gemini Live audio input sent (\(data.count) bytes).")
                } else if self.audioFramesSentCount % 50 == 0 {
                    print("[LiveVoice] Streaming audio input to Gemini Live (\(self.audioFramesSentCount) chunks sent)...")
                }
            }
        }
    }

    func stop() {
        networkQueue.async { [weak self] in
            guard let self, !self.stopped else { return }
            self.stopped = true
            self.socket?.cancel(with: .normalClosure, reason: nil)
            self.socket = nil
            self.webSocketSession?.invalidateAndCancel()
            self.webSocketSession = nil
            self.webSocketDelegate = nil
            self.output.stop()
            self.finishSession(status: "ENDED", failureCode: nil)
        }
    }

    private func openSession() {
        guard !stopped else { return }
        let url = serverURL.appendingPathComponent("api/voice/zalo-personal/live/session")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        // Render may cold-start and the CRM route then mints a Gemini token.
        // Keep this bounded, but do not fail a ringing call during a normal
        // cold start before the server has had a chance to answer.
        request.timeoutInterval = 35
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(deviceId, forHTTPHeaderField: "x-zalo-device-id")
        request.setValue("Bearer \(deviceSecret)", forHTTPHeaderField: "Authorization")
        var body: [String: Any] = ["local_call_id": localCallId]
        if let requestId { body["request_id"] = requestId }
        else {
            body["action"] = "start_inbound"
            if let remoteDisplayName { body["remote_display_name"] = remoteDisplayName }
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            self.networkQueue.async {
                guard !self.stopped else { return }
                guard error == nil, let http = response as? HTTPURLResponse, let data else {
                    self.fail("CRM refused the live voice session (network error).")
                    return
                }
                guard http.statusCode == 200,
                      let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                      json["ok"] as? Bool == true,
                      let accessToken = json["access_token"] as? String,
                      let sessionId = json["session_id"] as? String else {
                    let body = String(data: data, encoding: .utf8)?.prefix(240) ?? "<non-text>"
                    self.fail("CRM refused the live voice session (HTTP \(http.statusCode)): \(body)")
                    return
                }
                self.sessionId = sessionId
                let apiVersion = json["api_version"] as? String
                self.connectGeminiLive(accessToken: accessToken,
                                       model: json["model"] as? String,
                                       apiVersion: apiVersion)
            }
        }.resume()
    }

    private func connectGeminiLive(accessToken: String, model: String?, apiVersion: String? = nil) {
        let model = model ?? ProcessInfo.processInfo.environment["GEMINI_LIVE_MODEL"] ?? "gemini-2.5-flash-native-audio-preview-12-2025"
        let resolvedApiVersion = apiVersion ?? ProcessInfo.processInfo.environment["GEMINI_LIVE_API_VERSION"] ?? "v1alpha"
        guard let encodedToken = accessToken.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.\(resolvedApiVersion).GenerativeService.BidiGenerateContentConstrained?access_token=\(encodedToken)") else {
            fail("Invalid Gemini Live URL.")
            return
        }
        let delegate = WebSocketDelegate(
            onOpen: { [weak self] task, proto in
                guard let self else { return }
                self.networkQueue.async {
                    guard !self.stopped, self.socket === task else { return }
                    print("[LiveVoice] Gemini Live WebSocket opened.")
                    self.sendGeminiSetup(on: task, model: model)
                }
            },
            onClose: { [weak self] task, closeCode, reason in
                self?.networkQueue.async {
                    guard let self, !self.stopped else { return }
                    let reasonStr = reason.flatMap { String(data: $0, encoding: .utf8) }
                        ?? task.closeReason.flatMap { String(data: $0, encoding: .utf8) }
                        ?? "none"
                    let detail = "closeCode=\(closeCode.rawValue), closeReason=\(reasonStr), taskState=\(task.state.rawValue)"
                    print("[LiveVoice] WebSocket didCloseWith: \(detail)")
                    self.fail("Gemini Live socket closed (\(closeCode.rawValue)): \(reasonStr)")
                }
            },
            onComplete: { [weak self] task, error in
                self?.networkQueue.async {
                    guard let self, !self.stopped else { return }
                    if let error {
                        let ns = error as NSError
                        let wsTask = task as? URLSessionWebSocketTask
                        let closeCode = wsTask?.closeCode.rawValue ?? -1
                        let closeReasonStr = wsTask?.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? "none"
                        let detail = "domain=\(ns.domain), code=\(ns.code), description=\(error.localizedDescription), closeCode=\(closeCode), closeReason=\(closeReasonStr), taskState=\(task.state.rawValue), userInfo=\(ns.userInfo)"
                        print("[LiveVoice] WebSocket didCompleteWithError: \(detail)")
                        if !self.socketReady {
                            self.fail("Gemini Live socket completed before setupComplete: \(error.localizedDescription) [\(detail)]")
                        } else {
                            self.fail("Gemini Live socket completed: \(error.localizedDescription) [\(detail)]")
                        }
                    }
                }
            })
        webSocketDelegate = delegate
        webSocketSession = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        let task = webSocketSession!.webSocketTask(with: URLRequest(url: url))
        socket = task
        socketReady = false
        task.resume()
        started = true
    }

    private func sendGeminiSetup(on task: URLSessionWebSocketTask, model: String) {
        guard !stopped, socket === task else { return }
        let normalizedModel = model.hasPrefix("models/") ? model : "models/\(model)"
        let setupPayload: [String: Any] = [
            "model": normalizedModel,
            "generationConfig": [
                "responseModalities": ["AUDIO"]
            ]
        ]
        let setup: [String: Any] = ["setup": setupPayload]
        guard let data = try? JSONSerialization.data(withJSONObject: setup),
              let text = String(data: data, encoding: .utf8) else {
            fail("Failed to serialize Gemini Live setup payload.")
            return
        }
        task.send(.string(text)) { [weak self] error in
            guard let self else { return }
            self.networkQueue.async {
                guard !self.stopped, self.socket === task else { return }
                if let error {
                    let ns = error as NSError
                    self.fail("Gemini Live setup send failed: domain=\(ns.domain), code=\(ns.code), userInfo=\(ns.userInfo), description=\(error.localizedDescription)")
                    return
                }
                print("[LiveVoice] Gemini Live setup sent; waiting for setupComplete before audio.")
                self.receiveNext()
            }
        }
    }

    private func receiveNext() {
        guard let socket, !stopped else { return }
        socket.receive { [weak self] result in
            guard let self else { return }
            self.networkQueue.async {
                guard !self.stopped else { return }
                switch result {
                case .failure(let error):
                    self.handleReceiveFailure(error)
                case .success(let message):
                    self.handle(message)
                    self.receiveNext()
                }
            }
        }
    }

    private func handleReceiveFailure(_ error: Error) {
        guard !stopped else { return }
        let ns = error as NSError
        let closeCode = socket?.closeCode.rawValue ?? -1
        let closeReasonStr = socket?.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? "none"
        let taskState = socket?.state.rawValue ?? -1
        let detail = "domain=\(ns.domain), code=\(ns.code), description=\(error.localizedDescription), closeCode=\(closeCode), closeReason=\(closeReasonStr), taskState=\(taskState), userInfo=\(ns.userInfo)"
        print("[LiveVoice] WebSocket receive failed diagnostic: \(detail)")
        if closeCode > 0 && closeCode != URLSessionWebSocketTask.CloseCode.invalid.rawValue {
            fail("Gemini Live socket closed (\(closeCode)): \(closeReasonStr) [\(detail)]")
        } else {
            fail("WebSocket receive failed: \(error.localizedDescription) [\(detail)]")
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data?
        switch message {
        case .data(let value): data = value
        case .string(let value): data = value.data(using: .utf8)
        @unknown default: data = nil
        }
        guard let data else { return }
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            if let raw = String(data: data, encoding: .utf8) {
                print("[LiveVoice] Gemini Live non-JSON text frame received: \(raw.prefix(200))")
            }
            return
        }
        if let error = json["error"] as? [String: Any] {
            let detail = (try? JSONSerialization.data(withJSONObject: error))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "unknown error"
            print("[LiveVoice] Gemini Live returned error JSON: \(detail)")
            fail("Gemini Live returned an error: \(detail.prefix(240))")
            return
        }
        if json["setupComplete"] != nil {
            print("[LiveVoice] Gemini Live setupComplete received; audio bridge is ready and output is isolated to configured virtual device.")
            sendQueue.async { [weak self] in
                guard let self, !self.stopped else { return }
                self.socketReady = true
                if let socket = self.socket {
                    self.sendInitialGreeting(on: socket)
                }
                let queued = self.pendingInput
                self.pendingInput.removeAll(keepingCapacity: true)
                for chunk in queued {
                    guard let socket = self.socket else { break }
                    self.sendInputFrame(chunk, on: socket)
                }
            }
            return
        }
        if let content = json["serverContent"] as? [String: Any] {
            print("[LiveVoice] Gemini Live serverContent received.")
            if let turn = content["modelTurn"] as? [String: Any],
               let parts = turn["parts"] as? [[String: Any]] {
                for part in parts {
                    if let text = part["text"] as? String, !text.isEmpty {
                        print("[LiveVoice] AI: \(text)")
                    }
                    if let inlineData = part["inlineData"] as? [String: Any],
                       let encoded = inlineData["data"] as? String,
                       let audio = Data(base64Encoded: encoded) {
                        print("[LiveVoice] Gemini Live audio output received (\(audio.count) bytes).")
                        output.append(audio)
                    }
                }
            }
            if let turnComplete = content["turnComplete"] as? Bool, turnComplete {
                print("[LiveVoice] Gemini Live turnComplete received.")
            }
            return
        }
    }

    private func sendInitialGreeting(on socket: URLSessionWebSocketTask) {
        let turn: [String: Any] = [
            "role": "user",
            "parts": [
                ["text": "Cuộc gọi vừa được kết nối. Hãy chào khách hàng bằng một câu tiếng Việt ngắn gọn, ấm áp (1 câu) theo vai trò trợ lý doanh nghiệp."]
            ]
        ]
        let clientContent: [String: Any] = [
            "turns": [turn],
            "turnComplete": true
        ]
        let greetingMsg: [String: Any] = [
            "clientContent": clientContent
        ]
        guard let json = try? JSONSerialization.data(withJSONObject: greetingMsg),
              let text = String(data: json, encoding: .utf8) else { return }
        socket.send(.string(text)) { error in
            if let error {
                let ns = error as NSError
                print("[LiveVoice] Initial greeting trigger failed: domain=\(ns.domain), code=\(ns.code), description=\(error.localizedDescription)")
            } else {
                print("[LiveVoice] Gemini Live initial greeting trigger sent.")
            }
        }
    }

    private func fail(_ message: String, failureCode: String = "LIVE_VOICE_BRIDGE_ERROR") {
        networkQueue.async { [weak self] in
            guard let self, !self.stopped else { return }
            self.failure = message
            self.stopped = true
            self.socket?.cancel(with: .goingAway, reason: nil)
            self.socket = nil
            self.webSocketSession?.invalidateAndCancel()
            self.webSocketSession = nil
            self.webSocketDelegate = nil
            self.output.stop()
            print("[LiveVoice] Disabled for this call: \(message)")
            self.finishSession(status: "FAILED", failureCode: failureCode)
        }
    }

    private func finishSession(status: String, failureCode: String?) {
        guard let sessionId else { return }
        var request = URLRequest(url: serverURL.appendingPathComponent("api/voice/zalo-personal/live/session"))
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(deviceId, forHTTPHeaderField: "x-zalo-device-id")
        request.setValue("Bearer \(deviceSecret)", forHTTPHeaderField: "Authorization")
        var body: [String: Any] = ["action": "finish", "session_id": sessionId, "status": status]
        if let failureCode { body["failure_code"] = failureCode }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: request).resume()
        self.sessionId = nil
    }
}
