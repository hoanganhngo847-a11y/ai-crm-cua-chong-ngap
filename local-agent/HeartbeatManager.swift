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

    public func collectHealthPayload() -> HeartbeatPayload {
        let micAuth = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        let screenAuth = CGPreflightScreenCaptureAccess()
        let axAuth = AXIsProcessTrusted()

        let permissions = HeartbeatPermissions(
            microphone: micAuth,
            screen_recording: screenAuth,
            accessibility: axAuth
        )

        // Check if Zalo Desktop application is running
        let runningApps = NSWorkspace.shared.runningApplications
        let zaloIsRunning = runningApps.contains { app in
            app.bundleIdentifier == "com.vng.zalo" ||
            app.localizedName == "Zalo" ||
            app.bundleIdentifier == "com.vng.zalo.zalocall" ||
            app.localizedName == "ZaloCall"
        }

        return HeartbeatPayload(
            agent_version: Self.currentVersion,
            zalo_running: zaloIsRunning,
            permissions: permissions,
            loopback_ready: isLoopbackReady,
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
