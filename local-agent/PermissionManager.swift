import Foundation
import AVFoundation
import CoreGraphics
import ApplicationServices

public enum MicrophoneAuthorizationState: String, Codable {
    case authorized = "authorized"
    case denied = "denied"
    case restricted = "restricted"
    case notDetermined = "notDetermined"
}

public struct PermissionSnapshot: Codable {
    public let microphone: MicrophoneAuthorizationState
    public let screenRecording: Bool
    public let accessibility: Bool

    public var isAllGranted: Bool {
        microphone == .authorized && screenRecording && accessibility
    }

    public var permissionsOk: Bool {
        isAllGranted
    }
}

public final class PermissionManager {
    public static let shared = PermissionManager()

    public init() {}

    // MARK: - Passive Inspection (Truthful, Zero Dialogs/Prompts)

    public func currentMicrophoneState() -> MicrophoneAuthorizationState {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .authorized
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .denied
        }
    }

    public func currentScreenRecordingState() -> Bool {
        return CGPreflightScreenCaptureAccess()
    }

    public func currentAccessibilityState() -> Bool {
        return AXIsProcessTrusted()
    }

    /// Captures the current permission state passively without triggering any macOS prompts.
    public func snapshot() -> PermissionSnapshot {
        return PermissionSnapshot(
            microphone: currentMicrophoneState(),
            screenRecording: currentScreenRecordingState(),
            accessibility: currentAccessibilityState()
        )
    }

    // MARK: - Explicit User-Initiated Setup Mode

    /// Request microphone access if not determined. Calls completion with the updated state.
    public func requestMicrophoneAccess(completion: @escaping (MicrophoneAuthorizationState) -> Void) {
        let current = currentMicrophoneState()
        guard current == .notDetermined else {
            completion(current)
            return
        }
        AVCaptureDevice.requestAccess(for: .audio) { _ in
            DispatchQueue.main.async {
                completion(self.currentMicrophoneState())
            }
        }
    }

    /// Explicitly request screen recording access. Triggers macOS system prompt if not yet granted.
    @discardableResult
    public func requestScreenRecordingAccess() -> Bool {
        if currentScreenRecordingState() { return true }
        if #available(macOS 11.0, *) {
            return CGRequestScreenCaptureAccess()
        }
        return false
    }

    /// Explicitly request accessibility access. Triggers macOS system prompt if not yet trusted.
    @discardableResult
    public func requestAccessibilityAccess() -> Bool {
        if currentAccessibilityState() { return true }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    /// Deliberate user-operated permission setup workflow.
    /// Interactively prompts for ungranted permissions and outputs clear System Settings guidance.
    public func performUserSetup(completion: @escaping (PermissionSnapshot) -> Void) {
        print("=== Zalo Recorder Permission Setup ===")
        print("Initiating explicit permission requests for macOS...")

        // 1. Accessibility
        let axBefore = currentAccessibilityState()
        if !axBefore {
            print("[1/3] Prompting Accessibility permission...")
            _ = requestAccessibilityAccess()
        } else {
            print("[1/3] Accessibility: already GRANTED.")
        }

        // 2. Screen & System Audio
        let screenBefore = currentScreenRecordingState()
        if !screenBefore {
            print("[2/3] Prompting Screen & System Audio Recording permission...")
            _ = requestScreenRecordingAccess()
        } else {
            print("[2/3] Screen Recording: already GRANTED.")
        }

        // 3. Microphone
        print("[3/3] Checking Microphone authorization...")
        requestMicrophoneAccess { micState in
            let finalSnapshot = self.snapshot()
            self.printGuidance(snapshot: finalSnapshot)
            completion(finalSnapshot)
        }
    }

    public func printGuidance(snapshot: PermissionSnapshot) {
        print("\n--- Current Permission Status ---")
        print("  - Microphone: \(snapshot.microphone.rawValue.uppercased())")
        print("  - Screen Recording: \(snapshot.screenRecording ? "GRANTED" : "DENIED")")
        print("  - Accessibility: \(snapshot.accessibility ? "GRANTED" : "DENIED")")

        if snapshot.isAllGranted {
            print("\nSUCCESS: All required permissions are granted.")
        } else {
            print("\nATTENTION: One or more permissions require manual approval in System Settings.")
            if snapshot.accessibility == false {
                print("  -> System Settings > Privacy & Security > Accessibility: toggle 'Zalo Recorder' to ON")
            }
            if snapshot.screenRecording == false {
                print("  -> System Settings > Privacy & Security > Screen & System Audio Recording: toggle 'Zalo Recorder' to ON")
            }
            if snapshot.microphone != .authorized {
                print("  -> System Settings > Privacy & Security > Microphone: toggle 'Zalo Recorder' to ON")
            }
            print("Note: If macOS prompts you to 'Quit & Reopen', choose 'Quit & Reopen' or restart the agent.")
        }
    }
}
