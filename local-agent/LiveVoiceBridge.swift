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
    private var sessionId: String?
    private var stopped = false
    private var started = false
    private var socketReady = false
    private var pendingInput: [Data] = []
    private let maxPendingInputChunks = 150
    private var failure: String?

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
            socket.send(.string(text)) { error in
                if let error { self.fail("WebSocket audio send failed: \(error.localizedDescription)") }
            }
    }

    func stop() {
        networkQueue.async { [weak self] in
            guard let self, !self.stopped else { return }
            self.stopped = true
            self.socket?.cancel(with: .normalClosure, reason: nil)
            self.socket = nil
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
                self.connectGeminiLive(accessToken: accessToken, model: json["model"] as? String)
            }
        }.resume()
    }

    private func connectGeminiLive(accessToken: String, model: String?) {
        let model = model ?? ProcessInfo.processInfo.environment["GEMINI_LIVE_MODEL"] ?? "gemini-2.5-flash-native-audio-preview-12-2025"
        guard let encodedToken = accessToken.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=\(encodedToken)") else {
            fail("Invalid Gemini Live URL.")
            return
        }
        let task = URLSession.shared.webSocketTask(with: URLRequest(url: url))
        socket = task
        socketReady = false
        task.resume()
        started = true
        let setupPayload: [String: Any] = [
            "model": "models/\(model)",
            "responseModalities": ["AUDIO"]
        ]
        let setup: [String: Any] = ["setup": setupPayload]
        if let data = try? JSONSerialization.data(withJSONObject: setup),
           let text = String(data: data, encoding: .utf8) {
            task.send(.string(text)) { [weak self] error in
                guard let self else { return }
                self.sendQueue.async {
                    guard !self.stopped else { return }
                    if let error {
                        self.fail("Gemini Live setup failed: \(error.localizedDescription)")
                        return
                    }
                    self.socketReady = true
                    let queued = self.pendingInput
                    self.pendingInput.removeAll(keepingCapacity: true)
                    for data in queued {
                        self.sendInputFrame(data, on: task)
                    }
                    print("[LiveVoice] Gemini Live bridge connected; audio output is isolated to configured virtual device.")
                }
            }
        }
        receiveNext()
    }

    private func receiveNext() {
        guard let socket, !stopped else { return }
        socket.receive { [weak self] result in
            guard let self else { return }
            self.networkQueue.async {
                guard !self.stopped else { return }
                switch result {
                case .failure(let error): self.fail("WebSocket receive failed: \(error.localizedDescription)")
                case .success(let message):
                    self.handle(message)
                    self.receiveNext()
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data?
        switch message {
        case .data(let value): data = value
        case .string(let value): data = value.data(using: .utf8)
        @unknown default: data = nil
        }
        guard let data,
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = json["type"] as? String else { return }
        if type == "error" {
            fail("Gemini Live returned an error.")
            return
        }
        guard type == "serverContent", let content = json["serverContent"] as? [String: Any],
              let turn = content["modelTurn"] as? [String: Any],
              let parts = turn["parts"] as? [[String: Any]] else { return }
        for part in parts {
            guard let inlineData = part["inlineData"] as? [String: Any],
                  let encoded = inlineData["data"] as? String,
                  let audio = Data(base64Encoded: encoded) else { continue }
            output.append(audio)
        }
    }

    private func fail(_ message: String) {
        networkQueue.async { [weak self] in
            guard let self, !self.stopped else { return }
            self.failure = message
            self.stopped = true
            self.socket?.cancel(with: .goingAway, reason: nil)
            self.socket = nil
            self.output.stop()
            print("[LiveVoice] Disabled for this call: \(message)")
            self.finishSession(status: "FAILED", failureCode: "LIVE_VOICE_BRIDGE_ERROR")
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
