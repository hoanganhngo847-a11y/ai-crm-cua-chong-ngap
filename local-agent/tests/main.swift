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

// Test POST /call
var postReq = URLRequest(url: URL(string: "http://127.0.0.1:\(testPort)/call")!)
postReq.httpMethod = "POST"
postReq.setValue("application/json", forHTTPHeaderField: "Content-Type")
let sampleReqId = UUID().uuidString
postReq.httpBody = try JSONSerialization.data(withJSONObject: ["request_id": sampleReqId])

var postRespOk = false
let postSem = DispatchSemaphore(value: 0)
URLSession.shared.dataTask(with: postReq) { data, _, _ in
    defer { postSem.signal() }
    guard let data = data,
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    postRespOk = (json["ok"] as? Bool == true)
}.resume()
_ = postSem.wait(timeout: .now() + 2.0)
_ = testSem.wait(timeout: .now() + 2.0)
try require(postRespOk, "LoopbackServer /call accepts request")
try require(receivedReq == sampleReqId, "LoopbackServer delivers request_id to handler")

testServer.stop()
print("PASS: ZaloAutomation normalization, LoopbackServer health, CORS, and call dispatch")
print("ALL LOCAL AGENT REGRESSIONS PASSED")
