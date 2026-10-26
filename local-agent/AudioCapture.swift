import Foundation
import AVFoundation
import ScreenCaptureKit
import CoreMedia
import AudioToolbox

struct RecorderFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

struct TrackStatistics: Codable {
    var received_frames: Int64 = 0
    var padded_frames: Int64 = 0
    var overlapped_frames: Int64 = 0
}

// Both native streams are mapped to the host clock. Missing time is preserved as
// silence instead of compressing one side of the conversation or losing sync.
final class PCMTrackWriter {
    let url: URL
    let origin: CMTime
    private var file: ExtAudioFileRef?
    private var nativeFormat: AVAudioFormat?
    private var writtenFrames: Int64 = 0
    private(set) var statistics = TrackStatistics()

    init(url: URL, origin: CMTime) {
        self.url = url
        self.origin = origin
    }

    func append(_ sample: CMSampleBuffer, clock: CMClock?) throws {
        // Keep temporary Objective-C sample/format objects bounded on this queue.
        try autoreleasepool { try appendPCM(sample, clock: clock) }
    }

    private func appendPCM(_ sample: CMSampleBuffer, clock: CMClock?) throws {
        guard CMSampleBufferDataIsReady(sample),
              let description = CMSampleBufferGetFormatDescription(sample) else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        let frames = CMSampleBufferGetNumSamples(sample)
        guard frames > 0 else { return }
        if file == nil {
            // WAV stores interleaved samples. ExtAudioFile converts the callback
            // layout and provides explicit disposal/flush before finalization.
            var diskFormat = format.streamDescription.pointee
            if !format.isInterleaved {
                diskFormat.mFormatFlags &= ~kAudioFormatFlagIsNonInterleaved
                diskFormat.mBytesPerFrame *= diskFormat.mChannelsPerFrame
                diskFormat.mBytesPerPacket *= diskFormat.mChannelsPerFrame
            }
            var handle: ExtAudioFileRef?
            try check(ExtAudioFileCreateWithURL(url as CFURL, kAudioFileWAVEType,
                &diskFormat, nil, AudioFileFlags.eraseFile.rawValue, &handle), "create WAV")
            file = handle
            guard let handle = handle else { throw RecorderFailure(message: "No WAV file handle.") }
            try check(ExtAudioFileSetProperty(handle, kExtAudioFileProperty_ClientDataFormat,
                UInt32(MemoryLayout<AudioStreamBasicDescription>.size), format.streamDescription), "set PCM format")
            nativeFormat = format
        }
        guard let file = file, nativeFormat == format else {
            throw RecorderFailure(message: "Audio format changed during capture; raw tracks retained.")
        }
        var timestamp = CMSampleBufferGetPresentationTimeStamp(sample)
        if let clock = clock {
            timestamp = CMSyncConvertTime(timestamp, from: clock, to: CMClockGetHostTimeClock())
        }
        let relative = CMTimeGetSeconds(CMTimeSubtract(timestamp, origin))
        let elapsed = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), origin))
        guard relative.isFinite, abs(relative) < 7 * 24 * 3600, relative <= elapsed + 2 else {
            throw RecorderFailure(message: "Invalid audio host timestamp.")
        }
        let target = Int64((relative * format.sampleRate).rounded())
        // Ignore sub-frame rounding; remove genuine overlaps, including preroll.
        let overlap = max(0, writtenFrames - target)
        let skip = overlap > 1 ? min(Int64(frames), overlap) : 0
        statistics.overlapped_frames += skip
        guard skip < frames else { return }
        if target > writtenFrames + 1 {
            try pad(frames: target - writtenFrames, format: format)
        }
        let count = AVAudioFrameCount(Int64(frames) - skip)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count) else {
            throw RecorderFailure(message: "Cannot allocate audio buffer.")
        }
        buffer.frameLength = count
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sample, at: Int32(skip), frameCount: Int32(count), into: buffer.mutableAudioBufferList)
        guard status == noErr else {
            throw RecorderFailure(message: "Cannot copy PCM audio: \(status)")
        }
        try check(ExtAudioFileWrite(file, count, buffer.audioBufferList), "write PCM")
        statistics.received_frames += Int64(count)
        writtenFrames += Int64(count)
    }

    private func pad(frames: Int64, format: AVAudioFormat) throws {
        guard let file = file,
              let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096) else {
            throw RecorderFailure(message: "Cannot allocate silence buffer.")
        }
        var remaining = frames
        while remaining > 0 {
            silence.frameLength = AVAudioFrameCount(min(remaining, 4096))
            for buffer in UnsafeMutableAudioBufferListPointer(silence.mutableAudioBufferList) {
                if let data = buffer.mData { memset(data, 0, Int(buffer.mDataByteSize)) }
            }
            try check(ExtAudioFileWrite(file, silence.frameLength, silence.audioBufferList), "write silence")
            remaining -= Int64(silence.frameLength)
        }
        statistics.padded_frames += frames
        writtenFrames += frames
    }

    func close() throws {
        if let handle = file {
            file = nil
            try check(ExtAudioFileDispose(handle), "flush/close WAV")
        }
    }

    deinit { if let handle = file { ExtAudioFileDispose(handle) } }

    private func check(_ status: OSStatus, _ operation: String) throws {
        guard status == noErr else { throw RecorderFailure(message: "Cannot \(operation): \(status)") }
    }
}

// Only audio outputs are registered: no screen frames are saved. Including the
// Zalo app family also covers Chromium's separate audio service, not just the
// visible ZaloCall PID. No system output/input devices are changed here.
final class NativeCallCapture: NSObject, SCStreamOutput, SCStreamDelegate,
                               AVCaptureAudioDataOutputSampleBufferDelegate {
    private let queue = DispatchQueue(label: "zalo.audio.capture")
    private let sessionQueue = DispatchQueue(label: "zalo.audio.microphone-session")
    private let microphone = AVCaptureSession()
    private var stream: SCStream?
    private var stopped = false
    private var failure: String?
    private var realtimeSourceFormat: AVAudioFormat?
    private var realtimeConverter: AVAudioConverter?
    private let realtimeTargetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
        sampleRate: 16000, channels: 1, interleaved: true)!
    let remote: PCMTrackWriter
    let local: PCMTrackWriter
    var onFailure: ((String) -> Void)?
    var onRemotePCM16: ((Data) -> Void)?

    init(directory: URL) {
        let origin = CMClockGetTime(CMClockGetHostTimeClock())
        remote = PCMTrackWriter(url: directory.appendingPathComponent("remote.wav"), origin: origin)
        local = PCMTrackWriter(url: directory.appendingPathComponent("local.wav"), origin: origin)
        super.init()
    }

    static func isZalo(bundleID: String) -> Bool {
        let id = bundleID.lowercased()
        return id == "com.vng.zalo" || id.hasPrefix("com.vng.zalo.")
    }

    func start(completion: @escaping (Result<Void, Error>) -> Void) {
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            AVCaptureDevice.requestAccess(for: .audio) { allowed in
                if allowed { self.start(completion: completion) }
                else { completion(.failure(RecorderFailure(message: "Microphone access denied. Enable it in System Settings > Privacy & Security > Microphone."))) }
            }
            return
        }
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
            self.queue.async {
                guard !self.stopped else {
                    completion(.failure(RecorderFailure(message: "Capture cancelled.")))
                    return
                }
                do {
                    if let error = error { throw error }
                    guard let content = content, let display = content.displays.first else {
                        throw RecorderFailure(message: "No display available for app audio capture.")
                    }
                    let apps = content.applications.filter { Self.isZalo(bundleID: $0.bundleIdentifier) }
                    guard !apps.isEmpty else {
                        throw RecorderFailure(message: "Zalo is absent from the capture application list; refusing to capture other apps.")
                    }
                    let config = SCStreamConfiguration()
                    config.width = 2
                    config.height = 2
                    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
                    config.capturesAudio = true
                    config.sampleRate = 48000
                    config.channelCount = 2
                    config.excludesCurrentProcessAudio = true
                    let filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
                    let stream = SCStream(filter: filter, configuration: config, delegate: self)
                    try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: self.queue)
                    self.stream = stream

                    // Honor the selected physical/default microphone (including headsets).
                    guard let device = AVCaptureDevice.default(for: .audio) else {
                        throw RecorderFailure(message: "No default microphone available.")
                    }
                    let input = try AVCaptureDeviceInput(device: device)
                    let output = AVCaptureAudioDataOutput()
                    output.setSampleBufferDelegate(self, queue: self.queue)
                    guard self.microphone.canAddInput(input), self.microphone.canAddOutput(output) else {
                        throw RecorderFailure(message: "Cannot attach microphone capture.")
                    }
                    self.microphone.addInput(input)
                    self.microphone.addOutput(output)
                    stream.startCapture { error in
                        self.queue.async {
                            guard !self.stopped else { return }
                            if let error = error {
                                self.recordFailure(error)
                                completion(.failure(error))
                            } else {
                                self.sessionQueue.async {
                                    self.microphone.startRunning()
                                    self.queue.async {
                                        if !self.stopped { completion(.success(())) }
                                    }
                                }
                            }
                        }
                    }
                } catch {
                    self.recordFailure(error)
                    completion(.failure(error))
                }
            }
        }
    }

    func stop(completion: @escaping (String?) -> Void) {
        queue.async {
            self.stopped = true
            // Never block the sample-delivery queue in start/stopRunning.
            // The serial session queue also orders a pending start before stop.
            self.sessionQueue.async {
                if self.microphone.isRunning { self.microphone.stopRunning() }
                self.queue.async { self.stopAppStream(completion: completion) }
            }
        }
    }

    private func stopAppStream(completion: @escaping (String?) -> Void) {
            let finish = {
                self.queue.async {
                    do { try self.remote.close() } catch { self.recordFailure(error) }
                    do { try self.local.close() } catch { self.recordFailure(error) }
                    self.stream = nil
                    completion(self.failure)
                }
            }
            if let stream = self.stream {
                stream.stopCapture { error in
                    if let error = error { self.queue.async { self.recordFailure(error) } }
                    finish()
                }
            } else { finish() }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard !stopped, type == .audio else { return }
        do {
            try remote.append(sampleBuffer, clock: stream.synchronizationClock)
            if let pcm = try realtimePCM16(sampleBuffer) { onRemotePCM16?(pcm) }
        } catch { recordFailure(error) }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard !stopped else { return }
        do { try local.append(sampleBuffer, clock: microphone.synchronizationClock) }
        catch { recordFailure(error) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { self.recordFailure(error) }
    }

    private func recordFailure(_ error: Error) {
        guard failure == nil else { return }
        failure = error.localizedDescription
        onFailure?(error.localizedDescription)
    }

    /// ScreenCaptureKit currently delivers 48 kHz app audio while Gemini Live's
    /// WebSocket PCM contract is 16 kHz mono little-endian. Keep this adapter
    /// local to the capture queue so the recorder and live bridge share one
    /// source without changing Zalo's devices or the system default output.
    private func realtimePCM16(_ sample: CMSampleBuffer) throws -> Data? {
        guard CMSampleBufferDataIsReady(sample),
              let description = CMSampleBufferGetFormatDescription(sample) else { return nil }
        let sourceFormat = AVAudioFormat(cmAudioFormatDescription: description)
        let frames = CMSampleBufferGetNumSamples(sample)
        guard frames > 0 else { return nil }
        if realtimeSourceFormat == nil || realtimeSourceFormat != sourceFormat {
            realtimeSourceFormat = sourceFormat
            realtimeConverter = AVAudioConverter(from: sourceFormat, to: realtimeTargetFormat)
        }
        guard let converter = realtimeConverter,
              let source = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: AVAudioFrameCount(frames)) else {
            throw RecorderFailure(message: "Cannot create realtime audio converter.")
        }
        source.frameLength = AVAudioFrameCount(frames)
        let copyStatus = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sample, at: 0, frameCount: Int32(frames), into: source.mutableAudioBufferList)
        guard copyStatus == noErr else { throw RecorderFailure(message: "Cannot copy realtime PCM audio: \(copyStatus)") }

        let outputCapacity = AVAudioFrameCount(ceil(Double(frames) * 16000 / sourceFormat.sampleRate)) + 8
        guard let output = AVAudioPCMBuffer(pcmFormat: realtimeTargetFormat, frameCapacity: outputCapacity) else {
            throw RecorderFailure(message: "Cannot allocate realtime audio output.")
        }
        var supplied = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return source
        }
        guard status != .error, conversionError == nil, output.frameLength > 0,
              let pointer = output.int16ChannelData?[0] else {
            throw conversionError ?? RecorderFailure(message: "Realtime PCM conversion failed.")
        }
        return Data(bytes: pointer, count: Int(output.frameLength) * MemoryLayout<Int16>.size)
    }
}
