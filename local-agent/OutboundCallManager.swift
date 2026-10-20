import Foundation
import AppKit

public struct PendingOutboundContext {
    public let requestId: String
    public let customerId: String
    public let customerName: String
    public let expectedDisplayName: String
    public let phoneNormalized: String?
    public let triggeredAt: Date

    public init(requestId: String, customerId: String, customerName: String, expectedDisplayName: String, phoneNormalized: String?, triggeredAt: Date) {
        self.requestId = requestId
        self.customerId = customerId
        self.customerName = customerName
        self.expectedDisplayName = expectedDisplayName
        self.phoneNormalized = phoneNormalized
        self.triggeredAt = triggeredAt
    }
}

final class OutboundStateHelper {
    private let lock = NSLock()
    private var executingRequestId: String?
    private var pendingContext: PendingOutboundContext?
    private var boundContexts: [String: PendingOutboundContext] = [:]
    private var activeSessions: Set<String> = []
    private var ineligibleSessions: Set<String> = []

    init() {}

    func beginExecution(requestId: String, now: Date = Date()) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        if let pending = pendingContext, now.timeIntervalSince(pending.triggeredAt) > 120 {
            pendingContext = nil
        }

        if executingRequestId != nil || pendingContext != nil || !activeSessions.isEmpty {
            return false
        }
        executingRequestId = requestId
        return true
    }

    func cancelExecution(requestId: String) {
        lock.lock()
        defer { lock.unlock() }
        if executingRequestId == requestId {
            executingRequestId = nil
        }
    }

    func stagePending(context: PendingOutboundContext) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard executingRequestId == context.requestId else {
            return false
        }
        guard activeSessions.isDisjoint(with: ineligibleSessions) else {
            return false
        }
        executingRequestId = nil
        pendingContext = context
        return true
    }

    func clearPending(matching requestId: String) {
        lock.lock()
        defer { lock.unlock() }
        if pendingContext?.requestId == requestId {
            pendingContext = nil
        }
        if executingRequestId == requestId {
            executingRequestId = nil
        }
    }

    func registerActiveSession(callID: String) {
        lock.lock()
        defer { lock.unlock() }
        activeSessions.insert(callID)
    }

    func bindSession(
        callID: String,
        observedContactName: String?,
        direction: CallDirection,
        sessionStartedAt: Date,
        now: Date = Date()
    ) -> PendingOutboundContext? {
        lock.lock()
        defer { lock.unlock() }

        activeSessions.insert(callID)

        if ineligibleSessions.contains(callID) {
            return nil
        }

        if let existing = boundContexts[callID] {
            if direction == .inbound {
                boundContexts.removeValue(forKey: callID)
                ineligibleSessions.insert(callID)
                return nil
            }
            if let observed = observedContactName, !observed.isEmpty {
                let normObserved = ZaloAutomation.shared.normalizeName(observed)
                let normExpected = ZaloAutomation.shared.normalizeName(existing.expectedDisplayName)
                if !normObserved.isEmpty && normObserved != normExpected {
                    boundContexts.removeValue(forKey: callID)
                    ineligibleSessions.insert(callID)
                    return nil
                }
            }
            return existing
        }

        if direction == .inbound {
            ineligibleSessions.insert(callID)
            if let pending = pendingContext, sessionStartedAt >= pending.triggeredAt {
                pendingContext = nil
            }
            return nil
        }

        guard let pending = pendingContext else {
            return nil
        }

        if now.timeIntervalSince(pending.triggeredAt) > 120 {
            pendingContext = nil
            return nil
        }

        if sessionStartedAt < pending.triggeredAt {
            ineligibleSessions.insert(callID)
            pendingContext = nil
            return nil
        }

        guard let observed = observedContactName, !observed.isEmpty else {
            return nil
        }

        let normObserved = ZaloAutomation.shared.normalizeName(observed)
        let normExpected = ZaloAutomation.shared.normalizeName(pending.expectedDisplayName)

        guard !normObserved.isEmpty, normObserved == normExpected else {
            ineligibleSessions.insert(callID)
            if sessionStartedAt >= pending.triggeredAt {
                pendingContext = nil
            }
            return nil
        }

        boundContexts[callID] = pending
        pendingContext = nil
        return pending
    }

    func releaseSession(callID: String) {
        lock.lock()
        defer { lock.unlock() }
        activeSessions.remove(callID)
        boundContexts.removeValue(forKey: callID)
        ineligibleSessions.remove(callID)
    }
}

final class LockedResponseBox: @unchecked Sendable {
    private let lock = NSLock()
    private var tuple: (statusCode: Int?, ok: Bool) = (nil, false)

    func store(code: Int?, ok: Bool) {
        lock.lock()
        tuple = (code, ok)
        lock.unlock()
    }

    func load() -> (statusCode: Int?, ok: Bool) {
        lock.lock()
        defer { lock.unlock() }
        return tuple
    }
}

final class OutboundStatusSender: @unchecked Sendable {
    static let shared = OutboundStatusSender()

    func send(attempt: () -> (statusCode: Int?, ok: Bool)) -> Bool {
        for _ in 1...2 {
            let res = attempt()
            if let code = res.statusCode {
                if (200...299).contains(code) {
                    if res.ok { return true }
                    return false
                }
                if code == 429 || (500...599).contains(code) {
                    continue
                }
                return false
            } else {
                continue
            }
        }
        return false
    }
}

public final class OutboundCallManager {
    public static let shared = OutboundCallManager()

    let stateHelper = OutboundStateHelper()

    func bindOutboundContext(callID: String, contactName: String?, direction: CallDirection, startedAt: Date, now: Date = Date()) -> PendingOutboundContext? {
        return stateHelper.bindSession(callID: callID, observedContactName: contactName, direction: direction, sessionStartedAt: startedAt, now: now)
    }

    func registerActiveSession(callID: String) {
        stateHelper.registerActiveSession(callID: callID)
    }

    func releaseSession(callID: String) {
        stateHelper.releaseSession(callID: callID)
    }

    public func executeOutboundCall(requestId: String) {
        guard stateHelper.beginExecution(requestId: requestId) else {
            print("[Outbound] Rejecting executeOutboundCall(\(requestId)): agent is currently busy with execution, pending trigger, or active call.")
            return
        }

        guard let config = UploadConfiguration.load() else {
            print("[Outbound] Error: Local agent is not configured for upload.")
            stateHelper.cancelExecution(requestId: requestId)
            return
        }

        let secret: String
        do {
            secret = try config.secret()
        } catch {
            print("[Outbound] Error: Device secret unavailable in Keychain: \(error)")
            stateHelper.cancelExecution(requestId: requestId)
            return
        }

        // 1. Claim request from CRM
        print("[Outbound] Claiming request \(requestId)...")
        guard let payload = claimRequest(config: config, secret: secret, requestId: requestId) else {
            print("[Outbound] Failed to claim request \(requestId).")
            stateHelper.cancelExecution(requestId: requestId)
            return
        }

        let customerId = payload["customer_id"] as? String ?? ""
        let customerName = payload["customer_name"] as? String ?? ""
        let expectedName = (payload["expected_display_name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? customerName
        let phone = (payload["phone_normalized"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)

        print("[Outbound] Claimed request. Customer: '\(customerName)', Expected Zalo: '\(expectedName)', Phone: '\(phone ?? "none")'")

        // 2. Update status: OPENING_ZALO
        guard updateStatus(config: config, secret: secret, requestId: requestId, status: "OPENING_ZALO", reason: nil) else {
            stateHelper.cancelExecution(requestId: requestId)
            updateStatus(config: config, secret: secret, requestId: requestId, status: "FAILED", reason: "Không thể kết nối máy chủ để cập nhật trạng thái mở Zalo.")
            return
        }

        // 3. Search and open contact via Accessibility
        // Use phone if available, otherwise expected display name
        let searchQuery = (phone != nil && !phone!.isEmpty) ? phone! : expectedName
        print("[Outbound] Searching contact with query: '\(searchQuery)'...")

        let (state, activeConv) = ZaloAutomation.shared.searchAndOpenContact(query: searchQuery, expectedName: expectedName)
        print("[Outbound] Search result state: \(state.rawValue)")

        switch state {
        case .verified:
            guard let conv = activeConv else {
                updateStatus(config: config, secret: secret, requestId: requestId, status: "FAILED", reason: "Không thể đọc thông tin hội thoại.")
                stateHelper.cancelExecution(requestId: requestId)
                return
            }

            guard conv.hasVoiceCallButton, conv.voiceCallButtonPos != nil else {
                updateStatus(config: config, secret: secret, requestId: requestId, status: "FAILED", reason: "Cuộc gọi thoại không khả dụng cho liên hệ này.")
                print("[Outbound] Voice call button not available.")
                stateHelper.cancelExecution(requestId: requestId)
                return
            }

            // Update status: CONTACT_VERIFIED
            guard updateStatus(config: config, secret: secret, requestId: requestId, status: "CONTACT_VERIFIED", reason: nil) else {
                stateHelper.cancelExecution(requestId: requestId)
                updateStatus(config: config, secret: secret, requestId: requestId, status: "FAILED", reason: "Không thể xác nhận trạng thái liên hệ với máy chủ.")
                return
            }

            // Capture timestamp immediately before trigger
            let triggerTime = Date()
            let context = PendingOutboundContext(
                requestId: requestId,
                customerId: customerId,
                customerName: customerName,
                expectedDisplayName: expectedName,
                phoneNormalized: phone,
                triggeredAt: triggerTime
            )

            // Trigger Voice Call (dynamically locates and verifies live AX button)
            print("[Outbound] Triggering voice call via verified AX element...")
            let clicked = ZaloAutomation.shared.triggerVoiceCall()
            if clicked {
                if stateHelper.stagePending(context: context) {
                    updateStatus(config: config, secret: secret, requestId: requestId, status: "CALL_TRIGGERED", reason: nil)
                    print("[Outbound] Call triggered successfully!")
                } else {
                    stateHelper.cancelExecution(requestId: requestId)
                    updateStatus(config: config, secret: secret, requestId: requestId, status: "FAILED", reason: "Không thể lưu trạng thái chờ cuộc gọi.")
                    print("[Outbound] Failed to stage pending context for request \(requestId).")
                }
            } else {
                stateHelper.cancelExecution(requestId: requestId)
                updateStatus(config: config, secret: secret, requestId: requestId, status: "FAILED", reason: "Không thể bấm nút gọi thoại tự động. Vui lòng bấm gọi thủ công.")
            }

        case .possibleMatch:
            stateHelper.cancelExecution(requestId: requestId)
            updateStatus(config: config, secret: secret, requestId: requestId, status: "FAILED", reason: "Đã mở Zalo nhưng chưa thể xác minh chắc chắn đúng liên hệ. Vui lòng gọi thủ công.")
            print("[Outbound] Possible match detected. Auto-call aborted for safety.")

        case .mismatch:
            stateHelper.cancelExecution(requestId: requestId)
            updateStatus(config: config, secret: secret, requestId: requestId, status: "FAILED", reason: "Liên hệ mở trên Zalo không khớp với thông tin khách hàng.")
            print("[Outbound] Mismatch detected. Auto-call aborted.")

        case .notFound:
            stateHelper.cancelExecution(requestId: requestId)
            updateStatus(config: config, secret: secret, requestId: requestId, status: "FAILED", reason: "Không tìm thấy liên hệ trên Zalo.")
            print("[Outbound] Contact not found on Zalo.")
        }
    }

    func notifyCallDetectedAsync(requestId: String) {
        DispatchQueue.global(qos: .utility).async {
            guard let config = UploadConfiguration.load(),
                  let secret = try? config.secret() else { return }
            self.updateStatus(config: config, secret: secret, requestId: requestId, status: "CALL_DETECTED", reason: nil)
        }
    }

    private func claimRequest(config: UploadConfiguration, secret: String, requestId: String) -> [String: Any]? {
        let url = config.server_url.appendingPathComponent("api/voice/zalo-personal/outbound/claim")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(config.device_id, forHTTPHeaderField: "x-zalo-device-id")
        req.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")

        let body = ["request_id": requestId]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let sem = DispatchSemaphore(value: 0)
        var responsePayload: [String: Any]? = nil

        let task = URLSession.shared.dataTask(with: req) { data, resp, err in
            defer { sem.signal() }
            guard let data = data,
                  let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let ok = json["ok"] as? Bool, ok,
                  let requestData = json["request"] as? [String: Any] else {
                return
            }
            responsePayload = requestData
        }
        task.resume()
        _ = sem.wait(timeout: .now() + 10)
        return responsePayload
    }

    @discardableResult
    private func updateStatus(config: UploadConfiguration, secret: String, requestId: String, status: String, reason: String?) -> Bool {
        let url = config.server_url.appendingPathComponent("api/voice/zalo-personal/outbound/status")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 5
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(config.device_id, forHTTPHeaderField: "x-zalo-device-id")
        req.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")

        var body: [String: Any] = [
            "request_id": requestId,
            "status": status
        ]
        if let r = reason { body["failure_reason"] = r }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        return OutboundStatusSender.shared.send {
            let box = LockedResponseBox()
            let sem = DispatchSemaphore(value: 0)
            let task = URLSession.shared.dataTask(with: req) { data, resp, _ in
                let http = resp as? HTTPURLResponse
                let code = http?.statusCode
                var ok = false
                if let data = data,
                   let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                   let okVal = json["ok"] as? Bool {
                    ok = okVal
                }
                box.store(code: code, ok: ok)
                sem.signal()
            }
            task.resume()
            if sem.wait(timeout: .now() + 5) == .timedOut {
                task.cancel()
                return (nil, false)
            }
            return box.load()
        }
    }
}
