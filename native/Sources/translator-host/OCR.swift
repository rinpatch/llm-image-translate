import CoreGraphics
import Foundation
import ImageIO
import Vision

// Boxes come back normalized to the image rather than in pixels: the extension
// downscales before sending, and it renders over an <img> that is some third
// size again, so pixel coordinates would be wrong twice over.
struct TextBox: Encodable {
    var text: String
    var x: Double
    var y: Double
    var w: Double
    var h: Double
    var confidence: Double
}

enum OCR {
    static func recognize(base64: String, languages: [String]?) throws -> [TextBox] {
        guard let data = Data(base64Encoded: base64) else {
            throw HostError.bad("image is not valid base64", code: "bad_request")
        }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw HostError.bad("could not decode the image", code: "bad_request")
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        if let languages, !languages.isEmpty {
            request.recognitionLanguages = languages
        } else {
            request.automaticallyDetectsLanguage = true
        }

        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])

        return (request.results ?? []).compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let box = observation.boundingBox
            // Vision measures up from the bottom-left corner, CSS down from the
            // top-left, so the y axis has to be flipped on the way out.
            return TextBox(
                text: candidate.string,
                x: Double(box.origin.x),
                y: Double(1 - box.origin.y - box.height),
                w: Double(box.width),
                h: Double(box.height),
                confidence: Double(candidate.confidence)
            )
        }
    }
}
