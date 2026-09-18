import Foundation

// Requests are handled one at a time on purpose: a page's batches arrive in
// reading order and the Translation sessions are cheaper to reuse serially.
let translator = Translator()
let encoder = JSONEncoder()
let decoder = JSONDecoder()

func send(_ response: Response) {
    guard let data = try? encoder.encode(response) else { return }
    Framing.write(data)
}

func handle(_ request: Request) async -> Response {
    do {
        switch request.action {
        case "ping":
            return Response(id: request.id, ok: true, status: "ready")

        case "availability":
            guard let source = request.source, let target = request.target else {
                throw HostError.bad("availability needs source and target", code: "bad_request")
            }
            let status = await translator.availability(source: source, target: target)
            return Response(id: request.id, ok: true, status: status, source: source)

        case "prepare":
            guard let source = request.source, let target = request.target else {
                throw HostError.bad("prepare needs source and target", code: "bad_request")
            }
            let status = try await translator.prepare(source: source, target: target)
            return Response(id: request.id, ok: true, status: status, source: source)

        case "translate":
            guard let texts = request.texts, let target = request.target else {
                throw HostError.bad("translate needs texts and target", code: "bad_request")
            }
            let (source, translations) = try await translator.translate(
                texts: texts, source: request.source, target: target
            )
            return Response(id: request.id, ok: true, source: source, translations: translations)

        case "ocr":
            guard let image = request.image else {
                throw HostError.bad("ocr needs an image", code: "bad_request")
            }
            let boxes = try OCR.recognize(base64: image, languages: request.languages)
            return Response(id: request.id, ok: true, boxes: boxes)

        default:
            throw HostError.bad("Unknown action \(request.action)", code: "bad_request")
        }
    } catch let HostError.bad(message, code) {
        return Response(id: request.id, ok: false, error: message, code: code)
    } catch {
        // notInstalled still slips through when a pack is removed between the
        // availability check and the call, so it gets the same code either way.
        let text = "\(error)"
        let code = text.contains("notInstalled") ? "needs_download" : "translation_failed"
        return Response(id: request.id, ok: false, error: text, code: code)
    }
}

let done = DispatchSemaphore(value: 0)

// Framing.read() blocks on the pipe, so it gets its own thread rather than
// parking one of the cooperative pool's threads for the life of the process.
let (stream, continuation) = AsyncStream.makeStream(of: Data.self)

let reader = Thread {
    while let data = Framing.read() {
        continuation.yield(data)
    }
    continuation.finish()
}
reader.stackSize = 512 * 1024
reader.start()

Task {
    for await data in stream {
        guard let request = try? decoder.decode(Request.self, from: data) else {
            send(Response(id: -1, ok: false, error: "Malformed request", code: "bad_request"))
            continue
        }
        send(await handle(request))
    }
    done.signal()
}

done.wait()
