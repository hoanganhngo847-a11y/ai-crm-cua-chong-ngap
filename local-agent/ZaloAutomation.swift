import Foundation
import ApplicationServices
import AppKit

public enum VerificationState: String {
    case verified = "VERIFIED"
    case possibleMatch = "POSSIBLE_MATCH"
    case mismatch = "MISMATCH"
    case notFound = "NOT_FOUND"
}

public struct ZaloActiveConversation {
    public let displayName: String
    public let hasVoiceCallButton: Bool
    public let voiceCallButtonPos: CGPoint?
    public let isStranger: Bool
}

public struct ZaloContactCandidate {
    public let name: String
    public let clickPoint: CGPoint
}

public final class ZaloAutomation {
    public static let shared = ZaloAutomation()
    public static let bundleID = "com.vng.zalo"

    public func normalizeName(_ name: String) -> String {
        return name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "vi_VN"))
            .replacingOccurrences(of: "đ", with: "d")
            .replacingOccurrences(of: "Đ", with: "d")
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .lowercased()
    }

    public func activateZalo() -> (NSRunningApplication, AXUIElement)? {
        guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == Self.bundleID }) else {
            return nil
        }
        app.activate(options: .activateIgnoringOtherApps)
        let pid = app.processIdentifier
        let appAx = AXUIElementCreateApplication(pid)
        AXUIElementSetAttributeValue(appAx, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(appAx, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        return (app, appAx)
    }

    public func getMainWindow(appAx: AXUIElement) -> AXUIElement? {
        var winRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(appAx, kAXMainWindowAttribute as CFString, &winRef) == .success, let win = winRef {
            return (win as! AXUIElement)
        }
        var winsRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(appAx, kAXWindowsAttribute as CFString, &winsRef) == .success,
           let wins = winsRef as? [AXUIElement], let first = wins.first {
            return first
        }
        return nil
    }

    public func readActiveConversation(mainWin: AXUIElement) -> ZaloActiveConversation? {
        var candidateName: String?
        var hasVoice = false
        var voicePos: CGPoint?
        var isStranger = false

        func traverse(e: AXUIElement, depth: Int) {
            if depth > 25 { return }
            var vRef: CFTypeRef?, dRef: CFTypeRef?
            AXUIElementCopyAttributeValue(e, kAXValueAttribute as CFString, &vRef)
            AXUIElementCopyAttributeValue(e, kAXDescriptionAttribute as CFString, &dRef)

            let val = ((vRef as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let desc = ((dRef as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

            // Chat input placeholder: "Nhập @, tin nhắn tới <Name>"
            if desc.hasPrefix("Nhập @, tin nhắn tới ") {
                let name = desc.replacingOccurrences(of: "Nhập @, tin nhắn tới ", with: "").trimmingCharacters(in: .whitespaces)
                if !name.isEmpty { candidateName = name }
            }
            if val.hasPrefix("Nhập @, tin nhắn tới ") {
                let name = val.replacingOccurrences(of: "Nhập @, tin nhắn tới ", with: "").trimmingCharacters(in: .whitespaces)
                if !name.isEmpty { candidateName = name }
            }

            if desc == "Cuộc gọi thoại" {
                var posRef: CFTypeRef?, sizeRef: CFTypeRef?
                AXUIElementCopyAttributeValue(e, kAXPositionAttribute as CFString, &posRef)
                AXUIElementCopyAttributeValue(e, kAXSizeAttribute as CFString, &sizeRef)
                var pt = CGPoint.zero, sz = CGSize.zero
                if let p = posRef { AXValueGetValue(p as! AXValue, .cgPoint, &pt) }
                if let s = sizeRef { AXValueGetValue(s as! AXValue, .cgSize, &sz) }
                if sz.width > 0 && sz.height > 0 {
                    hasVoice = true
                    voicePos = CGPoint(x: pt.x + sz.width / 2, y: pt.y + sz.height / 2)
                }
            }

            if val == "NGƯỜI LẠ" || desc == "NGƯỜI LẠ" {
                isStranger = true
            }

            var childrenRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &childrenRef) == .success,
               let children = childrenRef as? [AXUIElement] {
                for child in children {
                    traverse(e: child, depth: depth + 1)
                }
            }
        }

        traverse(e: mainWin, depth: 0)
        guard let name = candidateName else { return nil }
        return ZaloActiveConversation(displayName: name, hasVoiceCallButton: hasVoice, voiceCallButtonPos: voicePos, isStranger: isStranger)
    }

    public func findSearchField(mainWin: AXUIElement) -> AXUIElement? {
        var result: AXUIElement?
        func traverse(e: AXUIElement, depth: Int) {
            if result != nil || depth > 20 { return }
            var rRef: CFTypeRef?
            AXUIElementCopyAttributeValue(e, kAXRoleAttribute as CFString, &rRef)
            if (rRef as? String) == "AXTextField" {
                result = e
                return
            }
            var cRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &cRef) == .success,
               let children = cRef as? [AXUIElement] {
                for child in children { traverse(e: child, depth: depth + 1) }
            }
        }
        traverse(e: mainWin, depth: 0)
        return result
    }

    public func click(at point: CGPoint) {
        let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
        let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
        down?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.05)
        up?.post(tap: .cghidEventTap)
    }

    public func searchAndOpenContact(query: String, expectedName: String) -> (VerificationState, ZaloActiveConversation?) {
        guard let (_, appAx) = activateZalo(), let mainWin = getMainWindow(appAx: appAx) else {
            return (.notFound, nil)
        }

        // 1. Locate search field
        guard let searchField = findSearchField(mainWin: mainWin) else {
            return (.notFound, nil)
        }

        // Focus search field
        AXUIElementSetAttributeValue(searchField, kAXFocusedAttribute as CFString, true as CFTypeRef)
        Thread.sleep(forTimeInterval: 0.1)

        // Clear and set query
        AXUIElementSetAttributeValue(searchField, kAXValueAttribute as CFString, "" as CFTypeRef)
        Thread.sleep(forTimeInterval: 0.1)
        AXUIElementSetAttributeValue(searchField, kAXValueAttribute as CFString, query as CFTypeRef)
        Thread.sleep(forTimeInterval: 0.2)

        // Submit search via Return key in Zalo Electron UI
        let returnDown = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true)
        let returnUp = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false)
        returnDown?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.05)
        returnUp?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.8)

        // 2. Check if active conversation matches
        let normExpected = normalizeName(expectedName)
        if let active = readActiveConversation(mainWin: mainWin) {
            let normActive = normalizeName(active.displayName)
            if normActive == normExpected {
                return (.verified, active)
            }
        }

        // 3. Fallback: Parse search candidates list if Return did not auto-open
        let candidates = parseCandidates(mainWin: mainWin)
        if candidates.isEmpty {
            // Re-check active conversation
            if let active = readActiveConversation(mainWin: mainWin) {
                let normActive = normalizeName(active.displayName)
                if normActive == normExpected { return (.verified, active) }
                if normActive.contains(normExpected) || normExpected.contains(normActive) { return (.possibleMatch, active) }
                return (.mismatch, active)
            }
            return (.notFound, nil)
        }

        let matching = candidates.filter { normalizeName($0.name) == normExpected }

        let chosenCandidate: ZaloContactCandidate
        if matching.count == 1 {
            chosenCandidate = matching[0]
        } else if matching.count > 1 {
            return (.possibleMatch, nil)
        } else {
            let partial = candidates.filter {
                let n = normalizeName($0.name)
                return n.contains(normExpected) || normExpected.contains(n)
            }
            if partial.count == 1 {
                chosenCandidate = partial[0]
            } else if partial.count > 1 {
                return (.possibleMatch, nil)
            } else {
                return (.notFound, nil)
            }
        }

        // Click candidate
        click(at: chosenCandidate.clickPoint)
        Thread.sleep(forTimeInterval: 0.6)

        // 4. Verify conversation header
        guard let active = readActiveConversation(mainWin: mainWin) else {
            return (.notFound, nil)
        }

        let normActive = normalizeName(active.displayName)
        if normActive == normExpected {
            return (.verified, active)
        } else if normActive.contains(normExpected) || normExpected.contains(normActive) {
            return (.possibleMatch, active)
        } else {
            return (.mismatch, active)
        }
    }

    public func parseCandidates(mainWin: AXUIElement) -> [ZaloContactCandidate] {
        var candidates: [ZaloContactCandidate] = []

        func collectItems(e: AXUIElement, depth: Int) {
            if depth > 10 { return }
            var rRef: CFTypeRef?, pRef: CFTypeRef?, sRef: CFTypeRef?
            AXUIElementCopyAttributeValue(e, kAXRoleAttribute as CFString, &rRef)
            AXUIElementCopyAttributeValue(e, kAXPositionAttribute as CFString, &pRef)
            AXUIElementCopyAttributeValue(e, kAXSizeAttribute as CFString, &sRef)

            let role = (rRef as? String) ?? ""
            var pt = CGPoint.zero, sz = CGSize.zero
            if let p = pRef { AXValueGetValue(p as! AXValue, .cgPoint, &pt) }
            if let s = sRef { AXValueGetValue(s as! AXValue, .cgSize, &sz) }

            // Search row candidate in left search list
            if role == "AXGroup" && pt.x >= 500 && pt.x <= 850 && pt.y >= 180 && sz.height >= 20 && sz.height <= 80 && sz.width >= 100 {
                var textParts: [String] = []
                func collectText(elem: AXUIElement) {
                    var vRef: CFTypeRef?
                    AXUIElementCopyAttributeValue(elem, kAXValueAttribute as CFString, &vRef)
                    if let v = vRef as? String, !v.trimmingCharacters(in: .whitespaces).isEmpty {
                        textParts.append(v.trimmingCharacters(in: .whitespaces))
                    }
                    var cRef: CFTypeRef?
                    if AXUIElementCopyAttributeValue(elem, kAXChildrenAttribute as CFString, &cRef) == .success, let children = cRef as? [AXUIElement] {
                        for c in children { collectText(elem: c) }
                    }
                }
                collectText(elem: e)
                let fullName = textParts.joined(separator: " ").trimmingCharacters(in: .whitespaces)
                let invalidKeywords = ["Tin nhắn", "Xem tất cả", "Chung nhóm", "Tất cả", "Liên hệ", "File"]
                if !fullName.isEmpty && !invalidKeywords.contains(where: { fullName.contains($0) }) {
                    // Do not deduplicate: retain every candidate so duplicate names yield possibleMatch
                    candidates.append(ZaloContactCandidate(name: fullName, clickPoint: CGPoint(x: pt.x + 40, y: pt.y + sz.height / 2)))
                }
            }

            var cRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &cRef) == .success, let children = cRef as? [AXUIElement] {
                for c in children { collectItems(e: c, depth: depth + 1) }
            }
        }

        collectItems(e: mainWin, depth: 0)
        return candidates
    }

    public func triggerVoiceCall() -> Bool {
        guard let (_, appAx) = activateZalo(), let mainWin = getMainWindow(appAx: appAx) else {
            return false
        }
        // Dynamically locate and verify the live AX element before clicking
        guard let conv = readActiveConversation(mainWin: mainWin),
              conv.hasVoiceCallButton,
              let buttonPos = conv.voiceCallButtonPos else {
            return false
        }
        click(at: buttonPos)
        return true
    }

    /// Accept only a button whose accessible label unambiguously means
    /// "answer/accept call". We never fall back to a blind coordinate because
    /// an incoming personal Zalo call can be from an unknown caller.
    public func acceptIncomingVoiceCall() -> Bool {
        let apps = zaloApplications()

        for app in apps {
            app.activate(options: .activateIgnoringOtherApps)
            let appAx = AXUIElementCreateApplication(app.processIdentifier)
            if let target = incomingAcceptTarget(appAx: appAx) {
                if target.pressable {
                    if AXUIElementPerformAction(target.element, kAXPressAction as CFString) == .success {
                        return true
                    }
                }
                if let point = target.point {
                    click(at: point)
                    return true
                }
            }
            if app.bundleIdentifier == "com.vng.zalo.zalocall" || app.localizedName == "ZaloCall",
               let point = incomingZaloCallFallbackPoint(appAx: appAx) {
                print("[Inbound] Using scoped ZaloCall incoming-call geometry fallback.")
                click(at: point)
                return true
            }
        }
        return false
    }

    /// Detect the ringing invite before ZaloCall creates its separate call
    /// window. This is intentionally read-only and does not activate Zalo.
    public func hasIncomingVoiceCallUI() -> Bool {
        for app in zaloApplications() {
            let appAx = AXUIElementCreateApplication(app.processIdentifier)
            if incomingAcceptTarget(appAx: appAx) != nil { return true }
        }
        return false
    }

    private func zaloApplications() -> [NSRunningApplication] {
        NSWorkspace.shared.runningApplications.filter { app in
            app.bundleIdentifier == Self.bundleID ||
            app.bundleIdentifier == "com.vng.zalo.zalocall" ||
            app.localizedName == "ZaloCall"
        }
    }

    private struct IncomingAcceptTarget {
        let element: AXUIElement
        let point: CGPoint?
        let pressable: Bool
    }

    private func incomingAcceptTarget(appAx: AXUIElement) -> IncomingAcceptTarget? {
        let acceptedLabels = [
            "nhận cuộc gọi", "trả lời", "trả lời cuộc gọi", "nghe máy",
            "answer", "answer call", "answer voice call", "answer video call",
            "accept", "accept call", "accept voice call", "accept video call",
            "join call"
        ]
        let rejectedLabels = ["từ chối", "decline", "reject", "end call", "cancel"]
        var windows: [AXUIElement] = []
        var windowsRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(appAx, kAXWindowsAttribute as CFString, &windowsRef) == .success,
           let values = windowsRef as? [AXUIElement] {
            windows = values
        }
        if let main = getMainWindow(appAx: appAx) { windows.insert(main, at: 0) }
        for window in windows {
            if let target = incomingAcceptTarget(root: window, acceptedLabels: acceptedLabels, rejectedLabels: rejectedLabels) {
                return target
            }
        }
        return nil
    }

    private func incomingAcceptTarget(root: AXUIElement, acceptedLabels: [String], rejectedLabels: [String]) -> IncomingAcceptTarget? {
        var result: IncomingAcceptTarget?
        var checkboxTargets: [IncomingAcceptTarget] = []
        var hasIncomingText = false
        func walk(_ element: AXUIElement, depth: Int) {
            if result != nil || depth > 20 { return }
            var roleRef: CFTypeRef?, titleRef: CFTypeRef?, descriptionRef: CFTypeRef?, valueRef: CFTypeRef?
            AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
            AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &titleRef)
            AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &descriptionRef)
            AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &valueRef)
            let role = (roleRef as? String) ?? ""
            let labels = [titleRef as? String, descriptionRef as? String, valueRef as? String]
                .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .map { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "vi_VN")).lowercased() }
            if labels.contains(where: { $0.contains("cuoc goi thoai den") || $0.contains("incoming call") || $0.contains("incoming voice call") }) {
                hasIncomingText = true
            }
            let normalizedAccepted = acceptedLabels.map {
                $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "vi_VN")).lowercased()
            }
            let normalizedRejected = rejectedLabels.map {
                $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "vi_VN")).lowercased()
            }
            let isRejected = labels.contains { label in normalizedRejected.contains(where: { label == $0 || label.contains($0) }) }
            let isAccepted = !isRejected && labels.contains { label in
                normalizedAccepted.contains(where: { label == $0 || label.contains($0) })
            }
            if isAccepted {
                var positionRef: CFTypeRef?, sizeRef: CFTypeRef?
                AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRef)
                AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef)
                var point = CGPoint.zero, size = CGSize.zero
                if let positionRef { AXValueGetValue(positionRef as! AXValue, .cgPoint, &point) }
                if let sizeRef { AXValueGetValue(sizeRef as! AXValue, .cgSize, &size) }
                var actionsRef: CFArray?
                let pressable = AXUIElementCopyActionNames(element, &actionsRef) == .success &&
                    ((actionsRef as? [String]) ?? []).contains(kAXPressAction as String)
                let center = size.width > 0 && size.height > 0
                    ? CGPoint(x: point.x + size.width / 2, y: point.y + size.height / 2)
                    : nil
                if pressable || center != nil {
                    result = IncomingAcceptTarget(element: element, point: center, pressable: pressable)
                }
                return
            }
            if role == "AXCheckBox", let target = targetFor(element: element) {
                checkboxTargets.append(target)
            }
            var childrenRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
               let children = childrenRef as? [AXUIElement] {
                for child in children { walk(child, depth: depth + 1) }
            }
        }
        walk(root, depth: 0)
        // ZaloCall exposes the incoming voice dialog as two unlabeled AXCheckBox
        // elements: decline on the left, accept on the right. Require the exact
        // incoming text and exactly two controls before selecting the right one.
        if result == nil, hasIncomingText, checkboxTargets.count == 2 {
            return checkboxTargets[1]
        }
        return result
    }

    private func targetFor(element: AXUIElement) -> IncomingAcceptTarget? {
        var positionRef: CFTypeRef?, sizeRef: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRef)
        AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef)
        var point = CGPoint.zero, size = CGSize.zero
        if let positionRef { AXValueGetValue(positionRef as! AXValue, .cgPoint, &point) }
        if let sizeRef { AXValueGetValue(sizeRef as! AXValue, .cgSize, &size) }
        var actionsRef: CFArray?
        let pressable = AXUIElementCopyActionNames(element, &actionsRef) == .success &&
            ((actionsRef as? [String]) ?? []).contains(kAXPressAction as String)
        let center = size.width > 0 && size.height > 0
            ? CGPoint(x: point.x + size.width / 2, y: point.y + size.height / 2)
            : nil
        guard pressable || center != nil else { return nil }
        return IncomingAcceptTarget(element: element, point: center, pressable: pressable)
    }

    /// ZaloCall currently renders the incoming dialog as a canvas: macOS
    /// exposes the window but not the two colored controls. The measured
    /// layout is the green accept control at about 62% width and 79% height.
    /// Scope this fallback to the small ZaloCall dialog so it cannot click a
    /// control in the main Zalo window or in another application.
    private func incomingZaloCallFallbackPoint(appAx: AXUIElement) -> CGPoint? {
        guard let window = getMainWindow(appAx: appAx) else { return nil }
        var positionRef: CFTypeRef?, sizeRef: CFTypeRef?
        AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionRef)
        AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRef)
        var position = CGPoint.zero, size = CGSize.zero
        if let positionRef { AXValueGetValue(positionRef as! AXValue, .cgPoint, &position) }
        if let sizeRef { AXValueGetValue(sizeRef as! AXValue, .cgSize, &size) }
        guard size.width >= 300, size.width <= 500,
              size.height >= 180, size.height <= 300 else { return nil }
        return CGPoint(x: position.x + size.width * 0.62,
                       y: position.y + size.height * 0.79)
    }
}
