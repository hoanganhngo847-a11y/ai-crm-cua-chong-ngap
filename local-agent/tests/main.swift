import Foundation
import AVFoundation
import CoreMedia

setbuf(stdout, nil)

do {
    var name: String? = RemoteDisplayName.retaining(nil, observed: "Zalo Call - Lương Thắng")
    for generic in ["Zalo Call", "Zalo", "", "  ", "Đang kết nối", "Cuộc gọi đến"] {
        name = RemoteDisplayName.retaining(name, observed: generic)
        guard name == "Lương Thắng" else { fatalError("Specific name overwritten") }
        guard RemoteDisplayName.specific(generic) == nil else { fatalError("Generic UI title accepted") }
    }
    guard RemoteDisplayName.retaining(nil, observed: "Zalo Call") == nil,
          RemoteDisplayName.retaining(nil, observed: "  Lương   Thắng  ") == "Lương Thắng",
          RemoteDisplayName.retaining(name, observed: "Another contact") == "Lương Thắng" else { fatalError("Name retention regression") }
    var entry = UploadEntry(local_call_id: UUID().uuidString, metadata_path: "/tmp/meta", recording_path: "/tmp/audio")
    for _ in 0..<12 { entry.failed(status: 503) }
    guard entry.state == "RETRY_PENDING", entry.requires_manual_retry, UploadEntry.retryDelay(100) == 3600 else { fatalError("Retry bound regression") }
    let recovered = try JSONDecoder().decode(UploadEntry.self, from: JSONEncoder().encode(entry))
    guard recovered.local_call_id == entry.local_call_id, recovered.attempts == 12 else { fatalError("Queue persistence regression") }
    var revoked = UploadEntry(local_call_id: UUID().uuidString, metadata_path: "/tmp/meta", recording_path: "/tmp/audio")
    revoked.failed(status: 401)
    guard revoked.requires_manual_retry, !UploadConfiguration.validServer(URL(string: "http://example.com")!),
          !UploadConfiguration.validServer(URL(string: "https://a:b@example.com")!),
          UploadConfiguration.validServer(URL(string: "https://example.com")!) else { fatalError("Credential/transport regression") }
    print("PASS: specific name retention, unknown name, durable queue identity, bounded retry and HTTPS configuration")
    let metadata = CallMetadata(id: UUID().uuidString, device_id: UUID().uuidString, direction: .unknown,
        started_at: "2026-10-20T01:00:00Z", ended_at: "2026-10-20T01:00:02Z", duration_seconds: 2,
        remote_display_name: "Lương Thắng", recording_path: "/tmp/test.m4a", remote_track_present: true,
        local_track_present: true, capture_error: nil, remote_timing: TrackStatistics(), local_timing: TrackStatistics(),
        audio_validation: AudioValidation(remote_non_silent: true, local_non_silent: true, duration: 2,
            remote_peak_db: -5, remote_mean_db: -20, local_peak_db: -5, local_mean_db: -20, status: "SIGNAL_PRESENT_BOTH_TRACKS"))
    let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(metadata)) as! [String: Any]
    guard encoded["schema_version"] as? Int == 1, encoded["remote_identity_type"] as? String == "DISPLAY_NAME_ONLY",
          encoded["local_call_id"] as? String == metadata.id, encoded["recording_file"] as? String == "test.m4a",
          encoded["phone_if_visible"] is NSNull, encoded["answered_at"] is NSNull else { fatalError("Metadata schema regression") }
    guard CallDirection.observed(["Đang kết nối"]) == .unknown,
          CallDirection.observed(["Cuộc gọi đến", "Đang kết nối"]) == .inbound,
          CallDirection.observed(["Calling"]) == .outbound,
          CallDirection.observed(["Incoming call", "Calling"]) == .unknown else { fatalError("Direction guess regression") }
}

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw RecorderFailure(message: "TEST FAILED: \(message)") }
}

do {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("zalo-queue-" + UUID().uuidString)
    let output = root.appendingPathComponent("recordings")
    let state = root.appendingPathComponent("state")
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: state.appendingPathComponent("queue"), withIntermediateDirectories: true)
    setenv("ZALO_AGENT_STATE_DIR", state.path, 1)
    defer { unsetenv("ZALO_AGENT_STATE_DIR"); try? FileManager.default.removeItem(at: root) }
    let device = UUID().uuidString.lowercased(), call = UUID().uuidString.lowercased()
    let config = UploadConfiguration(server_url: URL(string: "https://example.invalid")!, device_id: device, enrolled_at: Date(timeIntervalSince1970: 0))
    try JSONEncoder().encode(config).write(to: UploadConfiguration.file)
    let audio = output.appendingPathComponent("test.m4a"), metadata = output.appendingPathComponent("test.json")
    // Empty fixture deliberately stops before any credential lookup or network request.
    try Data().write(to: audio)
    let json: [String: Any] = ["schema_version": 1, "device_id": device, "local_call_id": call,
                              "started_at": "2026-10-20T00:00:00Z", "recording_file": "test.m4a"]
    try JSONSerialization.data(withJSONObject: json).write(to: metadata)
    var crashed = UploadEntry(local_call_id: call, metadata_path: metadata.path, recording_path: audio.path)
    crashed.state = "UPLOADING"; crashed.attempts = 3
    let entryFile = state.appendingPathComponent("queue/" + call + ".json")
    try JSONEncoder().encode(crashed).write(to: entryFile, options: .atomic)
    func waitForRetry() throws -> UploadEntry {
        for _ in 0..<200 {
            if let data = try? Data(contentsOf: entryFile), let entry = try? JSONDecoder().decode(UploadEntry.self, from: data), entry.state == "RETRY_PENDING" { return entry }
            Thread.sleep(forTimeInterval: 0.01)
        }
        throw RecorderFailure(message: "Queue recovery timed out")
    }
    let first = RecordingUploadQueue(); first.start(recordings: output)
    let recovered = try waitForRetry(); first.stop()
    try require(recovered.local_call_id == call && recovered.attempts == 4, "restart retains UUID and retry count after UPLOADING crash")
    try Data("corrupt state".utf8).write(to: entryFile)
    let second = RecordingUploadQueue(); second.start(recordings: output)
    let rebuilt = try waitForRetry(); second.stop()
    try require(rebuilt.local_call_id == call && rebuilt.attempts == 1, "corrupt queue rebuilt from finalized companion")
    let files = try FileManager.default.contentsOfDirectory(at: state.appendingPathComponent("queue"), includingPropertiesForKeys: nil)
    try require(files.filter { $0.pathExtension == "json" }.count == 1 && files.contains { $0.pathExtension == "corrupt" }, "one queue entry, corruption evidence retained")
    try require(FileManager.default.fileExists(atPath: audio.path) && FileManager.default.fileExists(atPath: metadata.path), "local recording and metadata retained on upload failure")
    print("PASS: disk-backed crash/restart recovery, corrupted state reconstruction, stable session ID, no local file deletion or network")
}

func signal(_ path: String, frequencies: [Double], amplitudes: [Double], duration: Double) throws {
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: AVAudioChannelCount(frequencies.count))!
    let count = AVAudioFrameCount(duration * 48000)
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count)!
    buffer.frameLength = count
    for channel in frequencies.indices {
        for frame in 0..<Int(count) {
            buffer.floatChannelData![channel][frame] = Float(amplitudes[channel] * sin(2 * .pi * frequencies[channel] * Double(frame) / 48000))
        }
    }
    var settings = format.settings
    settings[AVLinearPCMIsNonInterleaved] = false
    let file = try AVAudioFile(forWriting: URL(fileURLWithPath: path), settings: settings)
    try file.write(from: buffer)
}

func decoded(_ path: String) throws -> AVAudioPCMBuffer {
    // Decode all samples with ffmpeg. AVAudioFile.read(into:) on this machine
    // returned a short read (16384/16800 frames) even for a complete PCM WAV.
    let probe = try runCommand("/opt/homebrew/bin/ffprobe", ["-v", "error", "-show_entries", "stream=channels,sample_rate", "-of", "json", path])
    let json = try JSONSerialization.jsonObject(with: Data(probe.output.utf8)) as! [String: Any]
    let stream = (json["streams"] as! [[String: Any]])[0]
    let channels = stream["channels"] as! Int
    let sampleRate = Double(stream["sample_rate"] as! String)!
    let raw = URL(fileURLWithPath: path + ".decoded.f32")
    defer { try? FileManager.default.removeItem(at: raw) }
    let result = try runCommand("/opt/homebrew/bin/ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", path, "-c:a", "pcm_f32le", "-f", "f32le", raw.path])
    try require(result.status == 0, "decode test audio")
    let data = try Data(contentsOf: raw)
    let frames = data.count / (channels * MemoryLayout<Float>.size)
    let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: AVAudioChannelCount(channels))!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
    buffer.frameLength = AVAudioFrameCount(frames)
    data.withUnsafeBytes { bytes in
        let values = bytes.bindMemory(to: Float.self)
        for channel in 0..<channels {
            for frame in 0..<frames { buffer.floatChannelData![channel][frame] = values[frame * channels + channel] }
        }
    }
    return buffer
}

func magnitude(_ buffer: AVAudioPCMBuffer, channel: Int, frequency: Double) -> Double {
    // Measure the middle second to avoid codec/limiter startup transients.
    var real = 0.0
    var imaginary = 0.0
    for frame in 12000..<60000 {
        let sample = Double(buffer.floatChannelData![channel][frame])
        let phase = 2 * Double.pi * frequency * Double(frame) / 48000
        real += sample * cos(phase)
        imaginary += sample * sin(phase)
    }
    return hypot(real, imaginary)
}

func pcmSample(origin: CMTime, offset: Int64, count: Int = 4800) throws -> CMSampleBuffer {
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: true)!
    var description: CMAudioFormatDescription?
    try require(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: format.streamDescription,
        layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil,
        formatDescriptionOut: &description) == noErr, "create PCM format")
    var block: CMBlockBuffer?
    try require(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
        blockLength: count * 4, blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
        offsetToData: 0, dataLength: count * 4, flags: 0, blockBufferOut: &block) == noErr, "create PCM block")
    let samples = [Float](repeating: 0.25, count: count)
    let copyStatus = samples.withUnsafeBytes {
        CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: count * 4)
    }
    try require(copyStatus == noErr, "populate PCM block")
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48000),
        presentationTimeStamp: CMTimeAdd(origin, CMTime(value: offset, timescale: 48000)), decodeTimeStamp: .invalid)
    var sampleSize = 4
    var sample: CMSampleBuffer?
    try require(CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block,
        formatDescription: description, sampleCount: count, sampleTimingEntryCount: 1,
        sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: &sampleSize,
        sampleBufferOut: &sample) == noErr, "create PCM sample")
    return sample!
}

let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("zalo-tests-" + UUID().uuidString)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: directory) }
let finalizer = RecordingFinalizer()
let remote = directory.appendingPathComponent("remote.wav").path
let local = directory.appendingPathComponent("local.wav").path

// Mono source must work (old c1 downmix failed); assert actual decoded channel identity.
try signal(remote, frequencies: [440], amplitudes: [0.6], duration: 2)
try signal(local, frequencies: [880], amplitudes: [0.3], duration: 1.5)
let destination = directory.appendingPathComponent("mono-input.m4a").path
_ = try finalizer.merge(remote: remote, local: local, destination: destination, duration: 2)
let buffer = try decoded(destination)
try require(buffer.format.channelCount == 2, "output must be stereo")
try require(magnitude(buffer, channel: 0, frequency: 440) > 50 * magnitude(buffer, channel: 0, frequency: 880), "left must contain remote")
try require(magnitude(buffer, channel: 1, frequency: 880) > 50 * magnitude(buffer, channel: 1, frequency: 440), "right must contain local")
let tail = (84000..<min(Int(buffer.frameLength), 93600)).map { abs(buffer.floatChannelData![1][$0]) }.max() ?? 1
try require(tail < 0.001, "short microphone track must be padded to full call length")
print("PASS: mono/stereo merge, channel identity, duration and silent padding")

try signal(remote, frequencies: [440, 440], amplitudes: [1.8, 1.8], duration: 2)
let limitedPath = directory.appendingPathComponent("limited.m4a").path
let raw = try finalizer.levels(remote)
try require(raw.peak_db > 4, "validation must detect float peaks above 0 dBFS")
_ = try finalizer.merge(remote: remote, local: local, destination: limitedPath, duration: 2)
let limited = try decoded(limitedPath)
var peak: Float = 0
for channel in 0..<2 {
    for frame in 0..<Int(limited.frameLength) { peak = max(peak, abs(limited.floatChannelData![channel][frame])) }
}
try require(peak < 1, "decoded AAC must retain headroom on over-range input (peak \(peak))")
print("PASS: stereo input, over-range detection and limiter without automatic make-up gain (peak \(peak))")

try signal(local, frequencies: [880], amplitudes: [0], duration: 2)
let silent = try finalizer.levels(local)
try require(!silent.nonSilent && silent.mean_db.isFinite, "silence must be a warning with JSON-safe metrics")
print("PASS: silent track detection")

let missingOutput = directory.appendingPathComponent("missing.m4a").path
var rejectedMissingInput = false
do {
    _ = try finalizer.merge(remote: directory.appendingPathComponent("absent.wav").path,
                           local: local, destination: missingOutput, duration: 2)
} catch {
    rejectedMissingInput = true
    try require(!FileManager.default.fileExists(atPath: missingOutput), "failed merge must not publish a final file")
    try require(FileManager.default.fileExists(atPath: local), "failed merge must retain raw audio")
}
try require(rejectedMissingInput, "missing input must fail")
print("PASS: failed merge publishes no final file and retains raw inputs")

let origin = CMTime(value: 100, timescale: 1)
let writerURL = directory.appendingPathComponent("timing.wav")
let writer = PCMTrackWriter(url: writerURL, origin: origin)
try writer.append(pcmSample(origin: origin, offset: 0), clock: nil)
try writer.append(pcmSample(origin: origin, offset: 9600), clock: nil)
try writer.append(pcmSample(origin: origin, offset: 12000), clock: nil)
try writer.close()
try require(writer.statistics.padded_frames == 4800, "timestamp gap must retain silence")
try require(writer.statistics.overlapped_frames == 2400, "overlap must not duplicate audio")
let timed = try decoded(writerURL.path)
try require(timed.frameLength == 16800, "timestamp-aligned length (actual \(timed.frameLength), stats \(writer.statistics))")
try require(abs(timed.floatChannelData![0][6000]) < 0.0001, "gap must contain zeros")
try require(abs(timed.floatChannelData![0][15000] - 0.25) < 0.0001, "post-overlap audio must survive")
print("PASS: native PCM timestamps preserve gaps and trim overlaps")

let preroll = PCMTrackWriter(url: directory.appendingPathComponent("preroll.wav"), origin: origin)
try preroll.append(pcmSample(origin: origin, offset: -2400), clock: nil)
try preroll.close()
try require(preroll.statistics.overlapped_frames == 2400, "preroll before common origin must be trimmed")
try require(preroll.statistics.received_frames == 2400, "remaining preroll samples must be kept")
try require(NativeCallCapture.isZalo(bundleID: "com.vng.zalo"), "include Zalo")
try require(NativeCallCapture.isZalo(bundleID: "com.vng.zalo.ZaloCall"), "include ZaloCall/helper family")
try require(!NativeCallCapture.isZalo(bundleID: "com.vng.zalofake"), "reject lookalike bundle prefix")
try require(!NativeCallCapture.isZalo(bundleID: "com.google.Chrome"), "never fall back to all system audio")
print("PASS: preroll alignment and app isolation")

// Test ZaloAutomation normalization
let auto = ZaloAutomation.shared
try require(auto.normalizeName("Lương Thắng") == "luong thang", "ZaloAutomation normalizes diacritics")
try require(auto.normalizeName("  Đặng   Văn   Lâm  ") == "dang van lam", "ZaloAutomation normalizes Đ and spaces")

// Test LoopbackServer and OutboundContext
let testPort: UInt16 = 48199
let testServer = LoopbackServer(port: testPort)
var receivedReq: String? = nil
let testSem = DispatchSemaphore(value: 0)
testServer.onCallRequest = { reqId in
    receivedReq = reqId
    testSem.signal()
}
try testServer.start()

// Test GET /health
let healthUrl = URL(string: "http://127.0.0.1:\(testPort)/health")!
let healthData = try Data(contentsOf: healthUrl)
let healthJson = try JSONSerialization.jsonObject(with: healthData) as! [String: Any]
try require(healthJson["ok"] as? Bool == true, "LoopbackServer /health responds ok")
try require(healthJson["version"] as? String == "1.2.0", "LoopbackServer /health reports version 1.2.0")

// Test HeartbeatManager payload collection
let heartbeatPayload = HeartbeatManager.shared.collectHealthPayload()
try require(heartbeatPayload.agent_version == "1.2.0", "HeartbeatManager collects version 1.2.0")
try require(heartbeatPayload.loopback_ready == true, "HeartbeatManager reflects loopback ready state")
let encodedHeartbeat = try JSONEncoder().encode(heartbeatPayload)
try require(!encodedHeartbeat.isEmpty, "HeartbeatManager payload encodes to JSON")

// Test POST /call with forbidden Origin
var forbiddenReq = URLRequest(url: URL(string: "http://127.0.0.1:\(testPort)/call")!)
forbiddenReq.httpMethod = "POST"
forbiddenReq.setValue("application/json", forHTTPHeaderField: "Content-Type")
forbiddenReq.setValue("https://evil-attacker.com", forHTTPHeaderField: "Origin")
forbiddenReq.httpBody = try JSONSerialization.data(withJSONObject: ["request_id": UUID().uuidString])
var forbiddenStatusCode = 0
let forbiddenSem = DispatchSemaphore(value: 0)
URLSession.shared.dataTask(with: forbiddenReq) { _, resp, _ in
    defer { forbiddenSem.signal() }
    if let http = resp as? HTTPURLResponse { forbiddenStatusCode = http.statusCode }
}.resume()
_ = forbiddenSem.wait(timeout: .now() + 2.0)
try require(forbiddenStatusCode == 403, "LoopbackServer rejects unauthorized Origin with 403 Forbidden")

// Test OPTIONS with forbidden Origin
var optionsReq = URLRequest(url: URL(string: "http://127.0.0.1:\(testPort)/call")!)
optionsReq.httpMethod = "OPTIONS"
optionsReq.setValue("https://evil-attacker.com", forHTTPHeaderField: "Origin")
var optionsForbiddenStatusCode = 0
let optionsSem = DispatchSemaphore(value: 0)
URLSession.shared.dataTask(with: optionsReq) { _, resp, _ in
    defer { optionsSem.signal() }
    if let http = resp as? HTTPURLResponse { optionsForbiddenStatusCode = http.statusCode }
}.resume()
_ = optionsSem.wait(timeout: .now() + 2.0)
try require(optionsForbiddenStatusCode == 403, "LoopbackServer rejects OPTIONS preflight from unauthorized Origin with 403")

// Test POST /call with allowed Origin
var postReq = URLRequest(url: URL(string: "http://127.0.0.1:\(testPort)/call")!)
postReq.httpMethod = "POST"
postReq.setValue("application/json", forHTTPHeaderField: "Content-Type")
postReq.setValue("https://ai-crm-cua-chong-ngap.onrender.com", forHTTPHeaderField: "Origin")
let sampleReqId = UUID().uuidString
postReq.httpBody = try JSONSerialization.data(withJSONObject: ["request_id": sampleReqId])

var postRespOk = false
var postRespOrigin: String? = nil
let postSem = DispatchSemaphore(value: 0)
URLSession.shared.dataTask(with: postReq) { data, resp, _ in
    defer { postSem.signal() }
    if let http = resp as? HTTPURLResponse {
        postRespOrigin = http.value(forHTTPHeaderField: "Access-Control-Allow-Origin")
    }
    guard let data = data,
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    postRespOk = (json["ok"] as? Bool == true)
}.resume()
_ = postSem.wait(timeout: .now() + 2.0)
_ = testSem.wait(timeout: .now() + 2.0)
try require(postRespOk, "LoopbackServer /call accepts request from allowed Origin")
try require(postRespOrigin == "https://ai-crm-cua-chong-ngap.onrender.com", "LoopbackServer reflects specific allowed Origin")
try require(receivedReq == sampleReqId, "LoopbackServer delivers request_id to handler")

testServer.stop()
print("PASS: ZaloAutomation normalization, LoopbackServer health, CORS allowlist & 403 reject, and call dispatch")

// MARK: - OutboundStateHelper Pure Unit Tests
do {
    // 1. Exact normalized early bind
    do {
        let helper = OutboundStateHelper()
        let t0 = Date(timeIntervalSince1970: 1000)
        let req1 = UUID().uuidString
        let ctx1 = PendingOutboundContext(
            requestId: req1,
            customerId: "cust-1",
            customerName: "Nguyen Van A",
            expectedDisplayName: "Lương Thắng",
            phoneNormalized: "0901234567",
            triggeredAt: t0
        )
        try require(helper.beginExecution(requestId: req1, now: t0), "beginExecution succeeds when idle")
        try require(!helper.beginExecution(requestId: "req-overlap", now: t0), "overlapping beginExecution rejected")
        try require(helper.stagePending(context: ctx1), "stagePending succeeds for executing request")
        try require(!helper.beginExecution(requestId: "req-overlap-pending", now: t0), "beginExecution rejected while pendingContext active")

        let bound = helper.bindSession(callID: "call-1", observedContactName: "  lương   thắng  ", direction: .outbound, sessionStartedAt: t0, now: t0.addingTimeInterval(5))
        try require(bound?.requestId == req1, "exact normalized equality binds pending context")
        helper.releaseSession(callID: "call-1")
    }

    // 2. Unknown later resolves same session; duplicate consume rejected
    do {
        let helper = OutboundStateHelper()
        let t0 = Date(timeIntervalSince1970: 2000)
        let req = UUID().uuidString
        let ctx = PendingOutboundContext(
            requestId: req,
            customerId: "cust-2",
            customerName: "Nguyen Van B",
            expectedDisplayName: "Nguyen Van B",
            phoneNormalized: nil,
            triggeredAt: t0
        )
        try require(helper.beginExecution(requestId: req, now: t0), "begin req")
        try require(helper.stagePending(context: ctx), "stage ctx")

        let callID = "call-defer"
        try require(helper.bindSession(callID: callID, observedContactName: nil, direction: .unknown, sessionStartedAt: t0, now: t0.addingTimeInterval(2)) == nil,
                    "unknown contact name defers binding without clearing pending")
        let bound = helper.bindSession(callID: callID, observedContactName: "Nguyen Van B", direction: .outbound, sessionStartedAt: t0, now: t0.addingTimeInterval(4))
        try require(bound?.requestId == req, "unknown name later resolves to same session")

        try require(helper.bindSession(callID: "call-other", observedContactName: "Nguyen Van B", direction: .outbound, sessionStartedAt: t0, now: t0.addingTimeInterval(6)) == nil,
                    "duplicate consumption prohibited; pending was consumed")
        helper.releaseSession(callID: "call-defer")
        helper.releaseSession(callID: "call-other")
    }

    // 3. Substring & customer-name fallback rejected
    do {
        let helper = OutboundStateHelper()
        let t0 = Date(timeIntervalSince1970: 3000)
        let req = UUID().uuidString
        let ctx = PendingOutboundContext(
            requestId: req,
            customerId: "cust-3",
            customerName: "Nguyen Van A",
            expectedDisplayName: "Lương Thắng",
            phoneNormalized: nil,
            triggeredAt: t0
        )
        _ = helper.beginExecution(requestId: req, now: t0)
        _ = helper.stagePending(context: ctx)

        try require(helper.bindSession(callID: "call-sub", observedContactName: "Thắng", direction: .outbound, sessionStartedAt: t0, now: t0) == nil,
                    "substring contact name rejected")
        try require(helper.bindSession(callID: "call-fallback", observedContactName: "Nguyen Van A", direction: .outbound, sessionStartedAt: t0, now: t0) == nil,
                    "customerName fallback rejected when expectedDisplayName is specific")
        helper.releaseSession(callID: "call-sub")
        helper.releaseSession(callID: "call-fallback")
    }

    // 4. Inbound / mismatch cannot later requalify & invalidates pending on competing call
    do {
        let helper = OutboundStateHelper()
        let t0 = Date(timeIntervalSince1970: 4000)
        let req = UUID().uuidString
        let ctx = PendingOutboundContext(
            requestId: req,
            customerId: "cust-4",
            customerName: "Tran Van C",
            expectedDisplayName: "Tran Van C",
            phoneNormalized: nil,
            triggeredAt: t0
        )
        _ = helper.beginExecution(requestId: req, now: t0)
        _ = helper.stagePending(context: ctx)

        let inboundCall = "call-inbound"
        try require(helper.bindSession(callID: inboundCall, observedContactName: "Tran Van C", direction: .inbound, sessionStartedAt: t0, now: t0) == nil,
                    "inbound call rejected from binding outbound request")
        try require(helper.bindSession(callID: inboundCall, observedContactName: "Tran Van C", direction: .outbound, sessionStartedAt: t0, now: t0.addingTimeInterval(2)) == nil,
                    "ineligible inbound session cannot later requalify")
        helper.releaseSession(callID: inboundCall)
    }

    do {
        let helper = OutboundStateHelper()
        let t0 = Date(timeIntervalSince1970: 4500)
        let req = UUID().uuidString
        let ctx = PendingOutboundContext(
            requestId: req,
            customerId: "cust-4b",
            customerName: "Tran Van C",
            expectedDisplayName: "Tran Van C",
            phoneNormalized: nil,
            triggeredAt: t0
        )
        _ = helper.beginExecution(requestId: req, now: t0)
        _ = helper.stagePending(context: ctx)

        let mismatchCall = "call-mismatch"
        try require(helper.bindSession(callID: mismatchCall, observedContactName: "Different Name", direction: .outbound, sessionStartedAt: t0, now: t0) == nil,
                    "mismatched contact name rejected")
        try require(helper.bindSession(callID: mismatchCall, observedContactName: "Tran Van C", direction: .outbound, sessionStartedAt: t0, now: t0.addingTimeInterval(2)) == nil,
                    "ineligible mismatched session cannot later requalify")
        helper.releaseSession(callID: mismatchCall)
    }

    // 5. Already-bound late contradiction invalidates
    do {
        let helper = OutboundStateHelper()
        let t0 = Date(timeIntervalSince1970: 5000)
        let req = UUID().uuidString
        let ctx = PendingOutboundContext(
            requestId: req,
            customerId: "cust-5",
            customerName: "Le Van D",
            expectedDisplayName: "Le Van D",
            phoneNormalized: nil,
            triggeredAt: t0
        )
        _ = helper.beginExecution(requestId: req, now: t0)
        _ = helper.stagePending(context: ctx)

        let callID = "call-bound-contradict"
        let bound = helper.bindSession(callID: callID, observedContactName: "Le Van D", direction: .unknown, sessionStartedAt: t0, now: t0.addingTimeInterval(2))
        try require(bound?.requestId == req, "initial binding succeeds")

        try require(helper.bindSession(callID: callID, observedContactName: nil, direction: .unknown, sessionStartedAt: t0, now: t0.addingTimeInterval(3))?.requestId == req,
                    "unknown name does not erase valid binding")

        try require(helper.bindSession(callID: callID, observedContactName: "Le Van D", direction: .inbound, sessionStartedAt: t0, now: t0.addingTimeInterval(4)) == nil,
                    "late inbound contradiction invalidates bound context")

        try require(helper.bindSession(callID: callID, observedContactName: "Le Van D", direction: .outbound, sessionStartedAt: t0, now: t0.addingTimeInterval(5)) == nil,
                    "invalidated session cannot re-bind")
        helper.releaseSession(callID: callID)
    }

    do {
        let helper = OutboundStateHelper()
        let t0 = Date(timeIntervalSince1970: 5500)
        let req = UUID().uuidString
        let ctx = PendingOutboundContext(
            requestId: req,
            customerId: "cust-5b",
            customerName: "Le Van D",
            expectedDisplayName: "Le Van D",
            phoneNormalized: nil,
            triggeredAt: t0
        )
        _ = helper.beginExecution(requestId: req, now: t0)
        _ = helper.stagePending(context: ctx)

        let callID = "call-bound-mismatch"
        _ = helper.bindSession(callID: callID, observedContactName: "Le Van D", direction: .outbound, sessionStartedAt: t0, now: t0.addingTimeInterval(2))

        try require(helper.bindSession(callID: callID, observedContactName: "Someone Else", direction: .outbound, sessionStartedAt: t0, now: t0.addingTimeInterval(4)) == nil,
                    "late mismatched contact name invalidates bound context")
        helper.releaseSession(callID: callID)
    }

    // 6. Pre-existing call cannot claim later outbound context
    do {
        let helper = OutboundStateHelper()
        let t0 = Date(timeIntervalSince1970: 6000)
        let req = UUID().uuidString
        let ctx = PendingOutboundContext(
            requestId: req,
            customerId: "cust-6",
            customerName: "Pham E",
            expectedDisplayName: "Pham E",
            phoneNormalized: nil,
            triggeredAt: t0
        )
        _ = helper.beginExecution(requestId: req, now: t0)
        _ = helper.stagePending(context: ctx)

        let olderCall = "call-older"
        let olderStart = t0.addingTimeInterval(-10)
        try require(helper.bindSession(callID: olderCall, observedContactName: "Pham E", direction: .outbound, sessionStartedAt: olderStart, now: t0) == nil,
                    "older session started before trigger cannot claim outbound context")
        helper.releaseSession(callID: olderCall)
    }

    // 7. Expiry with no window recovers & live bound call past 120s retained
    do {
        let helper = OutboundStateHelper()
        let t0 = Date(timeIntervalSince1970: 7000)
        let reqExpired = UUID().uuidString
        let ctxExpired = PendingOutboundContext(
            requestId: reqExpired,
            customerId: "cust-7",
            customerName: "Hoang F",
            expectedDisplayName: "Hoang F",
            phoneNormalized: nil,
            triggeredAt: t0
        )
        _ = helper.beginExecution(requestId: reqExpired, now: t0)
        _ = helper.stagePending(context: ctxExpired)

        let reqNew = UUID().uuidString
        try require(helper.beginExecution(requestId: reqNew, now: t0.addingTimeInterval(121)),
                    "expired pending with no active recording permits new execution")

        let ctxNew = PendingOutboundContext(
            requestId: reqNew,
            customerId: "cust-7b",
            customerName: "Hoang F",
            expectedDisplayName: "Hoang F",
            phoneNormalized: nil,
            triggeredAt: t0.addingTimeInterval(121)
        )
        _ = helper.stagePending(context: ctxNew)

        let callLive = "call-live"
        let bound = helper.bindSession(callID: callLive, observedContactName: "Hoang F", direction: .outbound, sessionStartedAt: t0.addingTimeInterval(121), now: t0.addingTimeInterval(125))
        try require(bound?.requestId == reqNew, "bind new call")

        let past120 = t0.addingTimeInterval(121 + 300)
        let retained = helper.bindSession(callID: callLive, observedContactName: "Hoang F", direction: .outbound, sessionStartedAt: t0.addingTimeInterval(121), now: past120)
        try require(retained?.requestId == reqNew, "live bound call past 120s is retained and not expired")
        helper.releaseSession(callID: callLive)
    }

    // 8. Trigger failure / cancellation clears execution
    do {
        let helper = OutboundStateHelper()
        let t0 = Date(timeIntervalSince1970: 8000)
        let req = UUID().uuidString
        try require(helper.beginExecution(requestId: req, now: t0), "begin execution")
        helper.cancelExecution(requestId: req)
        try require(helper.beginExecution(requestId: req, now: t0), "can begin again after cancellation")

        let ctx = PendingOutboundContext(
            requestId: req,
            customerId: "cust-8",
            customerName: "Vu G",
            expectedDisplayName: "Vu G",
            phoneNormalized: nil,
            triggeredAt: t0
        )
        _ = helper.stagePending(context: ctx)
        helper.clearPending(matching: req)
        try require(helper.bindSession(callID: "call-cleared", observedContactName: "Vu G", direction: .outbound, sessionStartedAt: t0, now: t0) == nil,
                    "cleared pending cannot be bound")
        helper.releaseSession(callID: "call-cleared")
    }

    // 9. Active call blocks overlap & stale release does not clear current session
    do {
        let helper = OutboundStateHelper()
        let t0 = Date(timeIntervalSince1970: 9000)
        let req = UUID().uuidString
        _ = helper.beginExecution(requestId: req, now: t0)
        let ctx = PendingOutboundContext(
            requestId: req,
            customerId: "cust-9",
            customerName: "Do H",
            expectedDisplayName: "Do H",
            phoneNormalized: nil,
            triggeredAt: t0
        )
        _ = helper.stagePending(context: ctx)
        _ = helper.bindSession(callID: "call-current", observedContactName: "Do H", direction: .outbound, sessionStartedAt: t0, now: t0)

        try require(!helper.beginExecution(requestId: "req-blocked", now: t0), "active session blocks new execution")

        helper.releaseSession(callID: "call-stale-other")
        try require(!helper.beginExecution(requestId: "req-still-blocked", now: t0), "stale release of unknown call does not unblock")

        helper.releaseSession(callID: "call-current")
        try require(helper.beginExecution(requestId: "req-unblocked", now: t0), "releasing current session unblocks execution")
    }
}
do {
        // a) beginExecution -> bindSession with direction .inbound while no pending -> stagePending false -> cancelExecution/release -> new begin succeeds
        let helperA = OutboundStateHelper()
        let t0 = Date(timeIntervalSince1970: 1000)
        try require(helperA.beginExecution(requestId: "req-a1", now: t0), "beginExecution req-a1 succeeds")
        let boundInbound = helperA.bindSession(
            callID: "call-inbound",
            observedContactName: "Customer A",
            direction: .inbound,
            sessionStartedAt: t0,
            now: t0
        )
        try require(boundInbound == nil, "inbound bindSession returns nil")
        let pendingA = PendingOutboundContext(
            requestId: "req-a1",
            customerId: "cust-1",
            customerName: "Customer A",
            expectedDisplayName: "Customer A",
            phoneNormalized: nil,
            triggeredAt: t0
        )
        try require(!helperA.stagePending(context: pendingA), "stagePending must fail when active and ineligible sessions overlap")
        helperA.cancelExecution(requestId: "req-a1")
        helperA.releaseSession(callID: "call-inbound")
        try require(helperA.beginExecution(requestId: "req-a2", now: t0), "new beginExecution succeeds after cleanup")

        // b) stage pending -> bind older session at fixed now -> release older -> new same-name session can't consume stale cleared pending
        let helperB = OutboundStateHelper()
        let tTrigger = Date(timeIntervalSince1970: 2000)
        try require(helperB.beginExecution(requestId: "req-b1", now: tTrigger), "beginExecution req-b1 succeeds")
        let pendingB = PendingOutboundContext(
            requestId: "req-b1",
            customerId: "cust-2",
            customerName: "Customer B",
            expectedDisplayName: "Customer B",
            phoneNormalized: nil,
            triggeredAt: tTrigger
        )
        try require(helperB.stagePending(context: pendingB), "stagePending req-b1 succeeds")
        let tOlder = Date(timeIntervalSince1970: 1990)
        let tNow = Date(timeIntervalSince1970: 2005)
        let boundOlder = helperB.bindSession(
            callID: "call-older",
            observedContactName: "Customer B",
            direction: .outbound,
            sessionStartedAt: tOlder,
            now: tNow
        )
        try require(boundOlder == nil, "older session does not bind")
        helperB.releaseSession(callID: "call-older")
        let tNew = Date(timeIntervalSince1970: 2010)
        let boundNew = helperB.bindSession(
            callID: "call-new",
            observedContactName: "Customer B",
            direction: .outbound,
            sessionStartedAt: tNew,
            now: tNew
        )
        try require(boundNew == nil, "new session cannot bind after pending context was cleared by older session")

        // c) concurrentPerform 16 on same fresh helper beginExecution fixedDate; NSLock winnercount exactly 1
        let helperC = OutboundStateHelper()
        let tFixed = Date(timeIntervalSince1970: 3000)
        let countLock = NSLock()
        var winnerCount = 0
        DispatchQueue.concurrentPerform(iterations: 16) { i in
            if helperC.beginExecution(requestId: "req-c-\(i)", now: tFixed) {
                countLock.lock()
                winnerCount += 1
                countLock.unlock()
            }
        }
        try require(winnerCount == 1, "exactly 1 winner out of 16 concurrent beginExecution calls")

}
print("PASS: OutboundStateHelper pure state machine & deterministic binding constraints")
do {
    let testCases: [(name: String, responses: [(statusCode: Int?, ok: Bool)], expectedCalls: Int, expectedOk: Bool)] = [
        ("200 true success 1 call", [(200, true)], 1, true),
        ("200 false malformed 1 call", [(200, false)], 1, false),
        ("503 false then 200 true success 2 calls", [(503, false), (200, true)], 2, true),
        ("nil false then 200 true success 2 calls", [(nil, false), (200, true)], 2, true),
        ("429 false then 200 true success 2 calls", [(429, false), (200, true)], 2, true),
        ("403 false no retry 1 call", [(403, false)], 1, false),
        ("409 false no retry 1 call", [(409, false)], 1, false),
        ("two transients false 2 calls bounded", [(503, false), (503, false)], 2, false),
        ("201 true success 1 call", [(201, true)], 1, true),
        ("500 true rejected without 2xx retry 2 calls false", [(500, true), (500, true)], 2, false)
    ]

    for tc in testCases {
        var callCount = 0
        let outcome = OutboundStatusSender.shared.send {
            defer { callCount += 1 }
            let item = callCount < tc.responses.count ? tc.responses[callCount] : tc.responses.last!
            return (statusCode: item.statusCode, ok: item.ok)
        }
        try require(outcome == tc.expectedOk, "\(tc.name): expected outcome \(tc.expectedOk) got \(outcome)")
        try require(callCount == tc.expectedCalls, "\(tc.name): expected calls \(tc.expectedCalls) got \(callCount)")
    }

    print("PASS: OutboundStatusSender deterministic tests")
}

do {
    // 1. Permission Snapshot Unit Tests
    let allGranted = PermissionSnapshot(microphone: .authorized, screenRecording: true, accessibility: true)
    try require(allGranted.isAllGranted == true, "allGranted.isAllGranted must be true")
    try require(allGranted.permissionsOk == true, "allGranted.permissionsOk must be true")

    let micDenied = PermissionSnapshot(microphone: .denied, screenRecording: true, accessibility: true)
    try require(micDenied.isAllGranted == false, "micDenied.isAllGranted must be false")

    let screenDenied = PermissionSnapshot(microphone: .authorized, screenRecording: false, accessibility: true)
    try require(screenDenied.isAllGranted == false, "screenDenied.isAllGranted must be false")

    let axDenied = PermissionSnapshot(microphone: .authorized, screenRecording: true, accessibility: false)
    try require(axDenied.isAllGranted == false, "axDenied.isAllGranted must be false")

    let uninit = PermissionSnapshot(microphone: .notDetermined, screenRecording: false, accessibility: false)
    try require(uninit.isAllGranted == false, "uninit.isAllGranted must be false")

    // Passive inspection does not throw or crash
    let currentSnap = PermissionManager.shared.snapshot()
    try require([MicrophoneAuthorizationState.authorized, .denied, .restricted, .notDetermined].contains(currentSnap.microphone), "valid microphone state")

    // 2. Heartbeat Collection (Zero interactive prompts)
    let heartbeat = HeartbeatManager.shared.collectHealthPayload()
    try require(heartbeat.agent_version == "1.2.0", "heartbeat version is 1.2.0")
    try require(heartbeat.permissions.microphone == (currentSnap.microphone == .authorized), "heartbeat mic matches passive snapshot")
    try require(heartbeat.permissions.screen_recording == currentSnap.screenRecording, "heartbeat screen matches passive snapshot")
    try require(heartbeat.permissions.accessibility == currentSnap.accessibility, "heartbeat ax matches passive snapshot")

    let hbData = try JSONEncoder().encode(heartbeat)
    let decodedHb = try JSONDecoder().decode(HeartbeatPayload.self, from: hbData)
    try require(decodedHb.agent_version == "1.2.0", "heartbeat JSON roundtrip")

    print("PASS: PermissionManager snapshot logic and passive Heartbeat reporting")
}

do {
    // Resolve agent directory for plist validation
    let agentDir: URL
    if CommandLine.arguments.count > 1 {
        agentDir = URL(fileURLWithPath: CommandLine.arguments[1])
    } else {
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        if FileManager.default.fileExists(atPath: cwd.appendingPathComponent("Info.plist").path) {
            agentDir = cwd
        } else if FileManager.default.fileExists(atPath: cwd.appendingPathComponent("local-agent/Info.plist").path) {
            agentDir = cwd.appendingPathComponent("local-agent")
        } else {
            agentDir = cwd
        }
    }

    // 3. Info.plist Key Validation
    let infoPlistURL = agentDir.appendingPathComponent("Info.plist")
    guard let infoData = try? Data(contentsOf: infoPlistURL),
          let infoDict = try? PropertyListSerialization.propertyList(from: infoData, options: [], format: nil) as? [String: Any] else {
        throw RecorderFailure(message: "Failed to read and parse Info.plist at \(infoPlistURL.path)")
    }

    try require(infoDict["CFBundleIdentifier"] as? String == "com.local.zalo-recorder", "CFBundleIdentifier is com.local.zalo-recorder")
    try require(infoDict["CFBundleExecutable"] as? String == "zalo-recorder", "CFBundleExecutable is zalo-recorder")
    try require(infoDict["CFBundlePackageType"] as? String == "APPL", "CFBundlePackageType is APPL")
    try require(infoDict["CFBundleShortVersionString"] as? String == "1.2.0", "CFBundleShortVersionString is 1.2.0")
    try require(infoDict["LSUIElement"] as? Bool == true || infoDict["LSUIElement"] as? String == "1", "LSUIElement is true")
    try require(infoDict["NSMicrophoneUsageDescription"] != nil, "NSMicrophoneUsageDescription is present")
    try require(infoDict["NSScreenCaptureUsageDescription"] != nil, "NSScreenCaptureUsageDescription is present")
    try require(infoDict["NSAudioCaptureUsageDescription"] != nil, "NSAudioCaptureUsageDescription is present")

    // URL Scheme check
    if let urlTypes = infoDict["CFBundleURLTypes"] as? [[String: Any]],
       let firstType = urlTypes.first,
       let schemes = firstType["CFBundleURLSchemes"] as? [String] {
        try require(schemes.contains("crm-zalo"), "CFBundleURLSchemes contains crm-zalo")
    } else {
        throw RecorderFailure(message: "CFBundleURLSchemes crm-zalo missing in Info.plist")
    }

    // 4. Entitlements Validation
    let entitlementsURL = agentDir.appendingPathComponent("entitlements.plist")
    guard let entData = try? Data(contentsOf: entitlementsURL),
          let entDict = try? PropertyListSerialization.propertyList(from: entData, options: [], format: nil) as? [String: Any] else {
        throw RecorderFailure(message: "Failed to read and parse entitlements.plist at \(entitlementsURL.path)")
    }

    try require(entDict["com.apple.security.device.audio-input"] as? Bool == true, "audio-input entitlement is true")
    try require(entDict["com.apple.security.app-sandbox"] == nil, "app-sandbox entitlement must be absent (non-sandboxed)")

    print("PASS: Info.plist and entitlements.plist structure, permissions metadata, and security settings")
}

print("ALL LOCAL AGENT REGRESSIONS PASSED")
