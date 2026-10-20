import Foundation

struct CommandResult {
    let status: Int32
    let output: String
}

func runCommand(_ executable: String, _ arguments: [String]) throws -> CommandResult {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    try process.run()
    // Drain before waitUntilExit: ffmpeg can otherwise block on a full pipe.
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return CommandResult(status: process.terminationStatus,
                         output: String(data: data, encoding: .utf8) ?? "")
}

struct AudioLevels: Codable {
    let peak_db: Double
    let mean_db: Double
    var nonSilent: Bool { mean_db > -55 && peak_db > -50 }
}

struct AudioValidation: Codable {
    let remote_non_silent: Bool
    let local_non_silent: Bool
    let duration: Double
    let remote_peak_db: Double
    let remote_mean_db: Double
    let local_peak_db: Double
    let local_mean_db: Double
    let status: String
}

struct CallMetadata: Encodable {
    let schema_version = 1
    let id: String
    var local_call_id: String { id }
    let source = "ZALO_PERSONAL"
    let remote_identity_type = "DISPLAY_NAME_ONLY"
    var identity_confidence: String { remote_display_name == nil ? "UNKNOWN" : "MEDIUM" }
    let phone_if_visible: String? = nil
    let device_id: String
    let agent_version = "2.0.0"
    let direction: CallDirection
    let started_at: String
    // A visible window does not establish when (or whether) the call was answered.
    let answered_at: String? = nil
    let ended_at: String
    let duration_seconds: Double
    let remote_display_name: String?
    let recording_path: String
    var recording_file: String { URL(fileURLWithPath: recording_path).lastPathComponent }
    let remote_track_present: Bool
    let local_track_present: Bool
    let channel_layout = "stereo (Left=remote/customer, Right=local/staff)"
    let capture_method = "ScreenCaptureKit Zalo app audio + AVCaptureSession default microphone"
    let capture_error: String?
    let remote_timing: TrackStatistics
    let local_timing: TrackStatistics
    let audio_validation: AudioValidation
    var crm_call_request_id: String? = nil

    // Explicit nulls distinguish unknown identity/answer timing from missing schema fields.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: MetadataKey.self)
        func put<T: Encodable>(_ key: String, _ value: T) throws { try c.encode(value, forKey: MetadataKey(stringValue: key)!) }
        try put("schema_version", schema_version); try put("id", id); try put("local_call_id", local_call_id)
        try put("source", source); try put("direction", direction)
        try put("remote_display_name", remote_display_name); try put("remote_identity_type", remote_identity_type)
        try put("identity_confidence", identity_confidence); try put("phone_if_visible", phone_if_visible)
        try put("device_id", device_id); try put("agent_version", agent_version)
        try put("started_at", started_at); try put("answered_at", answered_at); try put("ended_at", ended_at)
        try put("duration_seconds", duration_seconds); try put("recording_file", recording_file)
        try put("recording_path", recording_path); try put("remote_track_present", remote_track_present)
        try put("local_track_present", local_track_present); try put("channel_layout", channel_layout)
        try put("capture_method", capture_method); try put("capture_error", capture_error)
        try put("remote_timing", remote_timing); try put("local_timing", local_timing)
        try put("audio_validation", audio_validation)
        if let reqId = crm_call_request_id {
            try put("crm_call_request_id", reqId)
        }
    }
}

private struct MetadataKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

enum RemoteDisplayName {
    static func specific(_ raw: String?) -> String? {
        guard var value = raw?.precomposedStringWithCompatibilityMapping else { return nil }
        value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("Zalo Call - ") { value = String(value.dropFirst("Zalo Call - ".count)) }
        value = value.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
        let generic: Set<String> = ["zalo call", "zalo", "zalocall", "calling", "incoming call", "cuộc gọi đến", "đang gọi", "đang kết nối", "kết nối", "connecting", "cuộc gọi", "call", "unknown"]
        guard !value.isEmpty, value.count <= 200, !generic.contains(value.lowercased()),
              value.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        return value
    }

    static func retaining(_ existing: String?, observed: String?) -> String? {
        // First specific contact wins for this session. Connected generic titles cannot replace it.
        specific(existing) ?? specific(observed)
    }
}

enum CallDirection: String, Codable {
    case inbound = "INBOUND"
    case outbound = "OUTBOUND"
    case unknown = "UNKNOWN"
    static func observed(_ labels: [String]) -> Self {
        let labels = labels.map { $0.lowercased() }
        let inbound = labels.contains { $0.contains("cuộc gọi đến") || $0.contains("incoming call") }
        let outbound = labels.contains { $0 == "đang gọi" || $0 == "calling" }
        // Connecting occurs in both directions; conflicting labels remain unknown.
        if inbound == outbound { return .unknown }
        return inbound ? .inbound : .outbound
    }
}

final class RecordingFinalizer {
    let ffmpeg: String
    let ffprobe: String
    init(ffmpeg: String = "/opt/homebrew/bin/ffmpeg", ffprobe: String = "/opt/homebrew/bin/ffprobe") {
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
    }

    func levels(_ path: String) throws -> AudioLevels {
        let result = try runCommand(ffmpeg, ["-hide_banner", "-nostdin", "-i", path,
            "-af", "astats=metadata=0:reset=0", "-f", "null", "-"])
        guard result.status == 0 else { throw RecorderFailure(message: "Cannot validate \(path): \(result.output.suffix(2000))") }
        func value(_ label: String) -> Double {
            let values = result.output.components(separatedBy: "\n").compactMap { line -> Double? in
                guard let range = line.range(of: label) else { return nil }
                return Double(line[range.upperBound...].trimmingCharacters(in: .whitespaces))
            }
            // JSON cannot represent infinity (silent tracks report -inf).
            return values.filter { $0.isFinite }.max() ?? -100
        }
        return AudioLevels(peak_db: value("Peak level dB:"), mean_db: value("RMS level dB:"))
    }

    func merge(remote: String, local: String, destination: String, duration: Double) throws -> Double {
        guard duration.isFinite, duration > 0 else { throw RecorderFailure(message: "Invalid recording duration.") }
        let partial = URL(fileURLWithPath: destination).deletingPathExtension().path + ".partial.m4a"
        let seconds = String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), duration)
        // level=false is essential: alimiter defaults to automatic make-up gain,
        // which previously raised the limited signal back to full scale.
        // Leave 2.5 dB of sample headroom for AAC reconstruction overshoot.
        let channel = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,alimiter=limit=0.75:level=false:latency=true,apad,atrim=duration=\(seconds)"
        let result = try runCommand(ffmpeg, ["-hide_banner", "-nostdin", "-y", "-i", remote, "-i", local,
            "-filter_complex", "[0:a]\(channel)[rem];[1:a]\(channel)[loc];[rem][loc]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[a]",
            "-map", "[a]", "-c:a", "aac", "-b:a", "192k", partial])
        guard result.status == 0 else {
            throw RecorderFailure(message: "ffmpeg merge failed; raw tracks retained: \(result.output.suffix(3000))")
        }
        let probe = try runCommand(ffprobe, ["-v", "error", "-show_entries", "stream=channels,sample_rate:format=duration", "-of", "json", partial])
        guard probe.status == 0, let data = probe.output.data(using: .utf8),
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let streams = json["streams"] as? [[String: Any]], streams.count == 1,
              streams[0]["channels"] as? Int == 2, streams[0]["sample_rate"] as? String == "48000",
              let format = json["format"] as? [String: Any],
              let textDuration = format["duration"] as? String, let actualDuration = Double(textDuration),
              abs(actualDuration - duration) < 0.15 else {
            throw RecorderFailure(message: "Final stereo file validation failed; raw tracks retained.")
        }
        // Full decode catches corruption that a header-only probe misses.
        let decode = try runCommand(ffmpeg, ["-v", "error", "-xerror", "-nostdin", "-i", partial, "-f", "null", "-"])
        guard decode.status == 0 else { throw RecorderFailure(message: "Final audio decode failed: \(decode.output)") }
        try FileManager.default.moveItem(atPath: partial, toPath: destination)
        return actualDuration
    }
}
