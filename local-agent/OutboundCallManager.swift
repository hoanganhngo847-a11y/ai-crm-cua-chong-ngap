import Foundation
import AppKit

public struct PendingOutboundContext {
    public let requestId: String
    public let customerId: String
    public let customerName: String
    public let expectedDisplayName: String
    public let phoneNormalized: String?
    public let triggeredAt: Date
}

public final class OutboundCallManager {
    public static let shared = OutboundCallManager()

    private let lock = NSLock()
    private var activeContext: PendingOutboundContext?

    public func currentOutboundContext(for contactName: String?) -> PendingOutboundContext? {
        lock.lock()
        defer { lock.unlock() }

        guard let ctx = activeContext else { return nil }

        // Context expires if call wasn't detected within 120 seconds of trigger
        if Date().timeIntervalSince(ctx.triggeredAt) > 120 {
            activeContext = nil
            return nil
        }

        // If contact name is observed, verify it matches
        if let observed = contactName, !observed.isEmpty {
            let normObserved = ZaloAutomation.shared.normalizeName(observed)
            let normExpected = ZaloAutomation.shared.normalizeName(ctx.expectedDisplayName)
            let normCust = ZaloAutomation.shared.normalizeName(ctx.customerName)

            if normObserved != normExpected && normObserved != normCust &&
               !normObserved.contains(normExpected) && !normExpected.contains(normObserved) {
                // Different contact call detected
                return nil
            }
        }

        return ctx
    }

    public func clearActiveContext() {
        lock.lock()
        defer { lock.unlock() }
        activeContext = nil
    }

    public func executeOutboundCall(requestId: String) {
        guard let config = UploadConfiguration.load() else {
            print("[Outbound] Error: Local agent is not configured for upload.")
            return
        }

        let secret: String
        do {
            secret = try config.secret()
        } catch {
            print("[Outbound] Error: Device secret unavailable in Keychain: \(error)")
            return
        }

        // 1. Claim request from CRM
        print("[Outbound] Claiming request \(requestId)...")
        guard let payload = claimRequest(config: config, secret: secret, requestId: requestId) else {
            print("[Outbound] Failed to claim request \(requestId).")
            return
        }

        let customerId = payload["customer_id"] as? String ?? ""
        let customerName = payload["customer_name"] as? String ?? ""
        let expectedName = (payload["expected_display_name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? customerName
        let phone = (payload["phone_normalized"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)

        print("[Outbound] Claimed request. Customer: '\(customerName)', Expected Zalo: '\(expectedName)', Phone: '\(phone ?? "none")'")

        // 2. Update status: OPENING_ZALO
        updateStatus(config: config, secret: secret, requestId: requestId, status: "OPENING_ZALO", reason: nil)

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
                return
            }

            guard conv.hasVoiceCallButton, conv.voiceCallButtonPos != nil else {
                updateStatus(config: config, secret: secret, requestId: requestId, status: "FAILED", reason: "Cuộc gọi thoại không khả dụng cho liên hệ này.")
                print("[Outbound] Voice call button not available.")
                return
            }

            // Update status: CONTACT_VERIFIED
            updateStatus(config: config, secret: secret, requestId: requestId, status: "CONTACT_VERIFIED", reason: nil)

            // Register active outbound context
            let context = PendingOutboundContext(
                requestId: requestId,
                customerId: customerId,
                customerName: customerName,
                expectedDisplayName: expectedName,
                phoneNormalized: phone,
                triggeredAt: Date()
            )
            lock.lock()
            activeContext = context
            lock.unlock()

            // Trigger Voice Call (dynamically locates and verifies live AX button)
            print("[Outbound] Triggering voice call via verified AX element...")
            let clicked = ZaloAutomation.shared.triggerVoiceCall()
            if clicked {
                updateStatus(config: config, secret: secret, requestId: requestId, status: "CALL_TRIGGERED", reason: nil)
                print("[Outbound] Call triggered successfully!")
            } else {
                updateStatus(config: config, secret: secret, requestId: requestId, status: "FAILED", reason: "Không thể bấm nút gọi thoại tự động. Vui lòng bấm gọi thủ công.")
            }

        case .possibleMatch:
            updateStatus(config: config, secret: secret, requestId: requestId, status: "FAILED", reason: "Đã mở Zalo nhưng chưa thể xác minh chắc chắn đúng liên hệ. Vui lòng gọi thủ công.")
            print("[Outbound] Possible match detected. Auto-call aborted for safety.")

        case .mismatch:
            updateStatus(config: config, secret: secret, requestId: requestId, status: "FAILED", reason: "Liên hệ mở trên Zalo không khớp với thông tin khách hàng.")
            print("[Outbound] Mismatch detected. Auto-call aborted.")

        case .notFound:
            updateStatus(config: config, secret: secret, requestId: requestId, status: "FAILED", reason: "Không tìm thấy liên hệ trên Zalo.")
            print("[Outbound] Contact not found on Zalo.")
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

    private func updateStatus(config: UploadConfiguration, secret: String, requestId: String, status: String, reason: String?) {
        let url = config.server_url.appendingPathComponent("api/voice/zalo-personal/outbound/status")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(config.device_id, forHTTPHeaderField: "x-zalo-device-id")
        req.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")

        var body: [String: Any] = [
            "request_id": requestId,
            "status": status
        ]
        if let r = reason { body["failure_reason"] = r }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let sem = DispatchSemaphore(value: 0)
        let task = URLSession.shared.dataTask(with: req) { _, _, _ in
            sem.signal()
        }
        task.resume()
        _ = sem.wait(timeout: .now() + 5)
    }
}
