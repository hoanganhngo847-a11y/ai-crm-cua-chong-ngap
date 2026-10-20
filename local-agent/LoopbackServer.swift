import Foundation
import Darwin

public final class LoopbackServer {
    public static let defaultPort: UInt16 = 48123
    private let port: UInt16
    private var serverFd: Int32 = -1
    private var isRunning = false
    private let queue = DispatchQueue(label: "com.local.zalo-recorder.loopback", attributes: .concurrent)
    public var onCallRequest: ((String) -> Void)?

    public init(port: UInt16 = defaultPort) {
        self.port = port
    }

    public func start() throws {
        serverFd = socket(AF_INET, SOCK_STREAM, 0)
        guard serverFd >= 0 else {
            throw RecorderFailure(message: "Failed to create loopback socket (errno: \(errno))")
        }

        var opt: Int32 = 1
        setsockopt(serverFd, SOL_SOCKET, SO_REUSEADDR, &opt, socklen_t(MemoryLayout<Int32>.size))
        // Prevent SIGPIPE on write to closed socket
        var nosigpipe: Int32 = 1
        setsockopt(serverFd, SOL_SOCKET, SO_NOSIGPIPE, &nosigpipe, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(port.bigEndian)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let bindRes = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(serverFd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }

        guard bindRes >= 0 else {
            close(serverFd)
            serverFd = -1
            throw RecorderFailure(message: "Failed to bind loopback socket to port \(port) (errno: \(errno))")
        }

        guard listen(serverFd, 16) >= 0 else {
            close(serverFd)
            serverFd = -1
            throw RecorderFailure(message: "Failed to listen on loopback socket (errno: \(errno))")
        }

        isRunning = true
        print("[LoopbackServer] Listening on http://127.0.0.1:\(port)")

        queue.async { [weak self] in
            self?.acceptLoop()
        }
    }

    public func stop() {
        isRunning = false
        if serverFd >= 0 {
            close(serverFd)
            serverFd = -1
        }
    }

    private func acceptLoop() {
        while isRunning && serverFd >= 0 {
            var clientAddr = sockaddr_in()
            var clientLen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let clientFd = withUnsafeMutablePointer(to: &clientAddr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    accept(serverFd, $0, &clientLen)
                }
            }

            guard clientFd >= 0 else {
                if !isRunning { break }
                Thread.sleep(forTimeInterval: 0.05)
                continue
            }

            queue.async { [weak self] in
                self?.handleClient(clientFd)
            }
        }
    }

    private func handleClient(_ fd: Int32) {
        defer { close(fd) }

        var data = Data()
        var buf = [UInt8](repeating: 0, count: 2048)
        while true {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            data.append(contentsOf: buf[0..<n])
            let str = String(decoding: data, as: UTF8.self)
            if str.contains("\r\n\r\n") {
                if let clRange = str.range(of: "Content-Length: ", options: .caseInsensitive),
                   let clEnd = str[clRange.upperBound...].range(of: "\r\n") {
                    let cl = Int(str[clRange.upperBound..<clEnd.lowerBound].trimmingCharacters(in: .whitespaces)) ?? 0
                    let bodyStart = str.range(of: "\r\n\r\n")!.upperBound
                    let bodyStr = String(str[bodyStart...])
                    if bodyStr.utf8.count >= cl { break }
                } else {
                    break
                }
            }
        }

        guard !data.isEmpty else { return }
        let requestString = String(decoding: data, as: UTF8.self)
        let lines = requestString.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return }

        let parts = requestLine.components(separatedBy: " ")
        guard parts.count >= 2 else { return }

        let method = parts[0].uppercased()
        let rawPath = parts[1]
        let pathComponents = rawPath.components(separatedBy: "?")
        let path = pathComponents[0]
        let query = pathComponents.count > 1 ? pathComponents[1] : ""

        // Handle CORS Preflight
        if method == "OPTIONS" {
            let response = "HTTP/1.1 204 No Content\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
                "Access-Control-Allow-Headers: Content-Type, Authorization\r\n" +
                "Access-Control-Max-Age: 86400\r\n\r\n"
            sendResponse(fd, response)
            return
        }

        // GET /health
        if method == "GET" && (path == "/health" || path == "/") {
            let deviceId = (try? AgentIdentity.deviceID()) ?? "unknown"
            let json = "{\"ok\":true,\"status\":\"READY\",\"device_id\":\"\(deviceId)\",\"version\":\"1.1.0\"}"
            sendJsonResponse(fd, json: json)
            return
        }

        // POST /call
        if method == "POST" && path == "/call" {
            var requestId: String? = nil

            // 1. Check query parameter ?request_id=...
            for param in query.components(separatedBy: "&") {
                let kv = param.components(separatedBy: "=")
                if kv.count == 2 && kv[0] == "request_id" {
                    requestId = kv[1]
                }
            }

            // 2. Check JSON body if not in query
            if requestId == nil, let bodyRange = requestString.range(of: "\r\n\r\n") {
                let body = String(requestString[bodyRange.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
                if let data = body.data(using: .utf8),
                   let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let req = dict["request_id"] as? String {
                    requestId = req
                }
            }

            guard let validReq = requestId?.trimmingCharacters(in: .whitespacesAndNewlines),
                  UUID(uuidString: validReq) != nil else {
                let errJson = "{\"ok\":false,\"error\":\"INVALID_REQUEST_ID\"}"
                sendJsonResponse(fd, json: errJson, status: 400)
                return
            }

            // Success dispatch
            let json = "{\"ok\":true,\"status\":\"DISPATCHED\",\"request_id\":\"\(validReq)\"}"
            sendJsonResponse(fd, json: json)

            // Trigger handler asynchronously
            if let handler = onCallRequest {
                DispatchQueue.global(qos: .userInitiated).async {
                    handler(validReq)
                }
            }
            return
        }

        // 404 for unknown routes
        sendJsonResponse(fd, json: "{\"ok\":false,\"error\":\"NOT_FOUND\"}", status: 404)
    }

    private func sendJsonResponse(_ fd: Int32, json: String, status: Int = 200) {
        let statusText = status == 200 ? "OK" : (status == 400 ? "Bad Request" : (status == 404 ? "Not Found" : "Error"))
        let data = json.data(using: .utf8) ?? Data()
        let headers = "HTTP/1.1 \(status) \(statusText)\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            "Content-Length: \(data.count)\r\n" +
            "Connection: close\r\n\r\n"
        sendResponse(fd, headers + json)
    }

    private func sendResponse(_ fd: Int32, _ string: String) {
        string.withCString { ptr in
            _ = write(fd, ptr, strlen(ptr))
        }
    }
}
