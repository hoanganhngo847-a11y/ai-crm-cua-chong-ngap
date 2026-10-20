import Foundation
import Security

enum AgentIdentity {
    static var directory: URL {
        let override = ProcessInfo.processInfo.environment["ZALO_AGENT_STATE_DIR"]
        return URL(fileURLWithPath: override ?? NSString(string: "~/Library/Application Support/ZaloRecordingAgent").expandingTildeInPath)
    }
    static func deviceID() throws -> String {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = directory.appendingPathComponent("device-id")
        if let value = try? String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), UUID(uuidString: value) != nil { return value }
        let value = UUID().uuidString.lowercased()
        try Data(value.utf8).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        return value
    }
    static func newAccountContext() throws {
        _ = try deviceID()
        let queue = directory.appendingPathComponent("queue")
        for file in (try? FileManager.default.contentsOfDirectory(at: queue, includingPropertiesForKeys: nil)) ?? [] where file.pathExtension == "json" {
            let entry = try JSONDecoder().decode(UploadEntry.self, from: Data(contentsOf: file))
            guard entry.state == "SERVER_CONFIRMED" else { throw RecorderFailure(message: "Finish pending uploads before changing account context.") }
        }
        if FileManager.default.fileExists(atPath: UploadConfiguration.file.path) {
            // Keep the previous configuration for diagnosis; the next context starts with upload disabled.
            try FileManager.default.moveItem(at: UploadConfiguration.file, to: directory.appendingPathComponent("previous-config-" + UUID().uuidString + ".json"))
        }
        let value = UUID().uuidString.lowercased()
        try Data(value.utf8).write(to: directory.appendingPathComponent("device-id"), options: .atomic)
        print("New account context Device ID: \(value). Revoke the previous device in CRM, register this ID, then configure upload.")
    }
}

func withAgentConfigurationLock(_ action: () throws -> Void) throws {
    let fd = open("/tmp/zalo-recorder-\(getuid()).lock", O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { throw RecorderFailure(message: "Cannot open agent lock.") }
    defer { close(fd) }
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw RecorderFailure(message: "Stop the recorder between calls before changing device/account configuration.") }
    try action()
}

struct UploadConfiguration: Codable {
    let server_url: URL
    let device_id: String
    let enrolled_at: Date
    static var file: URL { AgentIdentity.directory.appendingPathComponent("upload-config.json") }
    static func load() -> UploadConfiguration? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
    static func validServer(_ url: URL) -> Bool {
        guard url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/", url.host != nil else { return false }
        return url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(url.host!))
    }
    static func configure() throws {
        let id = try AgentIdentity.deviceID()
        print("Device ID: \(id)")
        print("Register this ID in CRM > Calls > Zalo devices. Use a new device registration when the Zalo account changes.")
        print("CRM origin (https://...): ", terminator: "")
        guard let line = readLine(), let url = URL(string: line), validServer(url) else { throw RecorderFailure(message: "Invalid CRM origin.") }
        guard let raw = getpass("Device secret (hidden): ") else { throw RecorderFailure(message: "Cannot read secret from Terminal.") }
        let secret = String(cString: raw)
        guard secret.count >= 40, secret.count <= 128 else { throw RecorderFailure(message: "Invalid device secret.") }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.local.zalo-recorder.device", kSecAttrAccount as String: id]
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = Data(secret.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw RecorderFailure(message: "Cannot save device secret in Keychain.") }
        let config = Self(server_url: url, device_id: id, enrolled_at: Date())
        try JSONEncoder().encode(config).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        print("Configured. Only new recordings will upload. Local recordings are retained.")
    }
    func secret() throws -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.local.zalo-recorder.device", kSecAttrAccount as String: device_id,
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
           let data = result as? Data, let value = String(data: data, encoding: .utf8) {
            return value
        }

        // Fallback for recompiled ad-hoc local agent binaries: query user login keychain via security CLI
        let pipe = Pipe()
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        proc.arguments = ["find-generic-password", "-s", "com.local.zalo-recorder.device", "-a", device_id, "-w"]
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do {
            try proc.run()
            proc.waitUntilExit()
            if proc.terminationStatus == 0 {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                if let str = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !str.isEmpty {
                    return str
                }
            }
        } catch {}

        throw RecorderFailure(message: "Device Keychain credential unavailable.")
    }
}

struct UploadEntry: Codable {
    let local_call_id: String
    let metadata_path: String
    let recording_path: String
    var state = "RECORDED"
    var attempts = 0
    var next_attempt_at = Date()
    var requires_manual_retry = false
    var call_id: String?
    var recording_id: String?

    static func retryDelay(_ attempts: Int) -> TimeInterval { min(3600, 5 * pow(2, Double(max(0, min(attempts - 1, 12))))) }
    mutating func failed(status: Int?) {
        attempts += 1
        state = "RETRY_PENDING"
        requires_manual_retry = attempts >= 12 || (status != nil && (400..<500).contains(status!) && ![408,409,429].contains(status!))
        next_attempt_at = Date().addingTimeInterval(Self.retryDelay(attempts))
    }
}

private final class NoUploadRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

final class RecordingUploadQueue {
    static let shared = RecordingUploadQueue()
    private let worker = DispatchQueue(label: "zalo.recording.upload")
    private let session = URLSession(configuration: .ephemeral, delegate: NoUploadRedirects(), delegateQueue: nil)
    private var busy = false
    private var timer: DispatchSourceTimer?
    private var directory: URL { AgentIdentity.directory.appendingPathComponent("queue") }

    private func save(_ entry: UploadEntry) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = directory.appendingPathComponent(entry.local_call_id + ".json")
        try JSONEncoder().encode(entry).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
    private func entries() -> [UploadEntry] {
        ((try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "json" }.compactMap { url in
                guard let data = try? Data(contentsOf: url) else { return nil }
                return try? JSONDecoder().decode(UploadEntry.self, from: data)
            }
    }
    func start(recordings: URL) {
        worker.async {
            do {
                // Recover the finalize -> queue crash gap. Never import old/schema-less files.
                if let config = UploadConfiguration.load() {
                    for file in (try? FileManager.default.contentsOfDirectory(at: recordings, includingPropertiesForKeys: nil)) ?? [] where file.pathExtension == "json" {
                        try self.enqueueFile(file, config: config)
                    }
                }
                for var entry in self.entries() where ["UPLOADING", "RECORDED"].contains(entry.state) {
                    entry.state = "QUEUED"; try self.save(entry)
                }
            } catch { print("[Upload] Queue recovery failed; local files retained.") }
            let timer = DispatchSource.makeTimerSource(queue: self.worker)
            timer.schedule(deadline: .now(), repeating: 5)
            timer.setEventHandler { self.tick() }; timer.resume(); self.timer = timer
        }
    }
    func enqueue(_ recording: String) {
        worker.async {
            guard let config = UploadConfiguration.load() else { return }
            do { try self.enqueueFile(URL(fileURLWithPath: recording).deletingPathExtension().appendingPathExtension("json"), config: config); self.tick() }
            catch { print("[Upload] Could not queue recording; startup recovery will retry.") }
        }
    }
    private func enqueueFile(_ file: URL, config: UploadConfiguration) throws {
        let data = try Data(contentsOf: file)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["schema_version"] as? Int == 1, let id = json["local_call_id"] as? String, UUID(uuidString: id) != nil,
              json["device_id"] as? String == config.device_id,
              let started = json["started_at"] as? String, let date = ISO8601DateFormatter().date(from: started), date >= config.enrolled_at,
              let recording = json["recording_file"] as? String, recording == URL(fileURLWithPath: recording).lastPathComponent else { return }
        let existing = directory.appendingPathComponent(id + ".json")
        if FileManager.default.fileExists(atPath: existing.path) {
            if let saved = try? Data(contentsOf: existing), let entry = try? JSONDecoder().decode(UploadEntry.self, from: saved), entry.local_call_id == id { return }
            // Preserve corruption evidence, then recover from the finalized companion metadata.
            try FileManager.default.moveItem(at: existing, to: existing.appendingPathExtension(UUID().uuidString + ".corrupt"))
        }
        var entry = UploadEntry(local_call_id: id, metadata_path: file.path, recording_path: file.deletingLastPathComponent().appendingPathComponent(recording).path)
        try save(entry); entry.state = "QUEUED"; try save(entry)
    }
    func retryPending() throws {
        for var entry in entries() where entry.state == "RETRY_PENDING" {
            entry.requires_manual_retry = false; entry.attempts = 0; entry.next_attempt_at = Date(); try save(entry)
        }
        print("Pending uploads reset. Restart the agent to process them.")
    }
    func stop() {
        worker.sync { timer?.cancel(); timer = nil }
    }
    private func tick() {
        guard !busy, let config = UploadConfiguration.load(), UploadConfiguration.validServer(config.server_url),
              var entry = entries().filter({ ["QUEUED", "RETRY_PENDING"].contains($0.state) && !$0.requires_manual_retry && $0.next_attempt_at <= Date() }).sorted(by: { $0.next_attempt_at < $1.next_attempt_at }).first else { return }
        busy = true
        do {
            let file = URL(fileURLWithPath: entry.recording_path)
            let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size > 0, size <= 50 * 1024 * 1024 else { throw RecorderFailure(message: "Recording exceeds upload size limit.") }
            guard let json = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: entry.metadata_path))) as? [String: Any] else { throw RecorderFailure(message: "Invalid metadata.") }
            // Explicit allowlist: never transmit local paths, capture diagnostics, chat/session data.
            let keys = ["schema_version", "source", "local_call_id", "device_id", "agent_version", "direction", "remote_display_name", "remote_identity_type", "identity_confidence", "phone_if_visible", "started_at", "answered_at", "ended_at", "duration_seconds", "recording_file", "crm_call_request_id"]
            var metadata = json.filter { keys.contains($0.key) }
            let validation = json["audio_validation"] as? [String: Any] ?? [:]
            metadata["audio_validation"] = validation.filter { ["remote_non_silent", "local_non_silent"].contains($0.key) }
            let boundary = "zalo-" + UUID().uuidString
            var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n".utf8)
            body.append(try JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys]))
            body.append(Data("\r\n--\(boundary)\r\nContent-Disposition: form-data; name=\"recording\"; filename=\"recording.m4a\"\r\nContent-Type: audio/mp4\r\n\r\n".utf8))
            body.append(try Data(contentsOf: file)); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
            var request = URLRequest(url: config.server_url.appendingPathComponent("api/voice/zalo-personal/recordings"))
            request.httpMethod = "POST"; request.timeoutInterval = 180
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            request.setValue(config.device_id, forHTTPHeaderField: "X-Zalo-Device-Id")
            request.setValue("Bearer " + (try config.secret()), forHTTPHeaderField: "Authorization")
            entry.state = "UPLOADING"; try save(entry)
            let sent = entry
            session.uploadTask(with: request, from: body) { data, response, error in
                self.worker.async {
                    defer { self.busy = false }
                    var current = sent
                    let status = (response as? HTTPURLResponse)?.statusCode
                    let result = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                    if error == nil, status == 200, result?["ok"] as? Bool == true,
                       let call = result?["call_id"] as? String, UUID(uuidString: call) != nil,
                       let recording = result?["recording_id"] as? String, UUID(uuidString: recording) != nil {
                        current.state = "SERVER_CONFIRMED"; current.call_id = call; current.recording_id = recording
                        print("[Upload] SERVER_CONFIRMED \(current.local_call_id)")
                    } else { current.failed(status: status); print("[Upload] RETRY_PENDING \(current.local_call_id), HTTP \(status ?? 0)") }
                    do { try self.save(current) } catch { print("[Upload] State save failed; server idempotency protects restart retry.") }
                }
            }.resume()
        } catch {
            entry.failed(status: nil)
            try? save(entry); busy = false
            print("[Upload] RETRY_PENDING; check device configuration/local files. No files deleted.")
        }
    }
}
