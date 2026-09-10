import Foundation

// Chrome's native messaging framing: a 4-byte host-endian length, then UTF-8 JSON.
// Chrome refuses anything larger than 1 MiB coming back from the host, so the
// extension is responsible for keeping batches small enough to fit.
enum Framing {
    static let maxIncoming = 64 * 1024 * 1024

    static func read() -> Data? {
        guard let header = readExactly(4) else { return nil }
        let length = header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        guard length > 0, Int(length) <= maxIncoming else { return nil }
        return readExactly(Int(length))
    }

    static func write(_ payload: Data) {
        var length = UInt32(payload.count)
        var out = Data(bytes: &length, count: 4)
        out.append(payload)
        out.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let n = Foundation.write(1, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if n <= 0 { return }
                offset += n
            }
        }
    }

    // readData(ofLength:) can come back short on a pipe, so loop until satisfied.
    private static func readExactly(_ count: Int) -> Data? {
        var buffer = [UInt8](repeating: 0, count: count)
        var offset = 0
        while offset < count {
            let n = buffer.withUnsafeMutableBytes { raw in
                Foundation.read(0, raw.baseAddress!.advanced(by: offset), count - offset)
            }
            if n <= 0 { return nil }
            offset += n
        }
        return Data(buffer)
    }
}

struct Request: Decodable {
    var id: Int
    var action: String
    var source: String?
    var target: String?
    var texts: [String]?
}

struct Response: Encodable {
    var id: Int
    var ok: Bool
    var error: String?
    var code: String?
    var status: String?
    var source: String?
    var translations: [String]?
}

enum HostError: Error {
    case bad(String, code: String)
}
