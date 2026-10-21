import Foundation
import AppKit
import AVFoundation

public struct HeartbeatPermissions: Codable {
    public let microphone: Bool
    public let screen_recording: Bool
    public let accessibility: Bool
}

public struct HeartbeatPayload: Codable {
    public let agent_version: String
    public let zalo_running: Bool
    public let permissions: HeartbeatPermissions
    public let loopback_ready: Bool
    public let recording_ready: Bool
    public let error_code: String?
}

public final class HeartbeatManager {
    public static let shared = HeartbeatManager()
    public static let currentVersion = "1.2.0"

    private let worker = DispatchQueue(label: "com.local.zalo-recorder.heartbeat")
    private var timer: DispatchSourceTimer?
    private var isLoopbackReady: Bool = false
    private var lastReportedStatus: String = "UNKNOWN"

    public func setLoopbackReady(_ ready: Bool) {
        isLoopbackReady = ready
    }

    private func isLoopbackListening() -> Bool {
        if isLoopbackReady { return true }
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return false }
        defer { close(sock) }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(LoopbackServer.defaultPort.bigEndian)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        var timeout = timeval(tv_sec: 0, tv_usec: 200_000)
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

        let res = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return res == 0
    }

    public func collectHealthPayload() -> HeartbeatPayload {
        let snap = PermissionManager.shared.snapshot()

        let permissions = HeartbeatPermissions(
            microphone: snap.microphone == .authorized,
            screen_recording: snap.screenRecording,
            accessibility: snap.accessibility
        )

        // Check if Zalo Desktop application is running
        let runningApps = NSWorkspace.shared.runningApplications
        let zaloIsRunning = runningApps.contains { app in
            app.bundleIdentifier == "com.vng.zalo" ||
            app.localizedName == "Zalo" ||
            app.bundleIdentifier == "com.vng.zalo.zalocall" ||
            app.localizedName == "ZaloCall"
        }

        let loopbackActive = isLoopbackListening()

        return HeartbeatPayload(
            agent_version: Self.currentVersion,
            zalo_running: zaloIsRunning,
            permissions: permissions,
            loopback_ready: loopbackActive,
            recording_ready: true,
            error_code: nil
        )
    }

    public func start(intervalSeconds: TimeInterval = 30) {
        worker.async { [weak self] in
            guard let self = self else { return }
            self.timer?.cancel()
            let timer = DispatchSource.makeTimerSource(queue: self.worker)
            timer.schedule(deadline: .now() + 1, repeating: intervalSeconds)
            timer.setEventHandler { [weak self] in
                self?.sendHeartbeat()
            }
            timer.resume()
            self.timer = timer
        }
    }

    public func stop() {
        worker.async { [weak self] in
            self?.timer?.cancel()
            self?.timer = nil
        }
    }

    public func sendHeartbeat(completion: ((Bool, String?) -> Void)? = nil) {
        guard let config = UploadConfiguration.load() else {
            completion?(false, "Not enrolled")
            return
        }

        let secret: String
        do {
            secret = try config.secret()
        } catch {
            print("[Heartbeat] Device secret unavailable in Keychain: \(error.localizedDescription)")
            completion?(false, "Keychain error")
            return
        }

        let payload = collectHealthPayload()
        print("[Heartbeat] Payload: mic=\(payload.permissions.microphone) screen=\(payload.permissions.screen_recording) ax=\(payload.permissions.accessibility) zalo=\(payload.zalo_running) loopback=\(payload.loopback_ready)")
        guard let jsonData = try? JSONEncoder().encode(payload) else {
            completion?(false, "Encode error")
            return
        }

        let url = config.server_url.appendingPathComponent("api/voice/zalo-personal/devices/heartbeat")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(config.device_id, forHTTPHeaderField: "x-zalo-device-id")
        req.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        req.httpBody = jsonData

        let task = URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            if let err = err {
                print("[Heartbeat] Transport warning: \(err.localizedDescription)")
                completion?(false, err.localizedDescription)
                return
            }
            guard let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                print("[Heartbeat] Server returned status \(code)")
                completion?(false, "HTTP \(code)")
                return
            }

            if let data = data,
               let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let status = json["data"] as? [String: Any],
               let agentStatus = status["status"] as? String {
                if self?.lastReportedStatus != agentStatus {
                    self?.lastReportedStatus = agentStatus
                    print("[Heartbeat] Server status: \(agentStatus)")
                }
            }
            completion?(true, nil)
        }
        task.resume()
    }
}
