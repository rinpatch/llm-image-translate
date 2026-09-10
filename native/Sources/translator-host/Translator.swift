import Foundation
import NaturalLanguage
import Translation

actor Translator {
    private var sessions: [String: TranslationSession] = [:]

    func availability(source: String, target: String) async -> String {
        let from = Locale.Language(identifier: source)
        let to = Locale.Language(identifier: target)
        switch await LanguageAvailability().status(from: from, to: to) {
        case .installed: return "installed"
        case .supported: return "supported"
        case .unsupported: return "unsupported"
        @unknown default: return "unknown"
        }
    }

    // Language packs only download through a UI flow, so a headless host can do
    // no better than ask for it and report whether it landed.
    func prepare(source: String, target: String) async throws -> String {
        try await session(source: source, target: target, requireInstalled: false).prepareTranslation()
        return await availability(source: source, target: target)
    }

    func translate(texts: [String], source: String?, target: String) async throws -> (String, [String]) {
        let resolved = try resolveSource(source, texts: texts)
        if resolved == target { return (resolved, texts) }

        let session = try await session(source: resolved, target: target)
        let requests = texts.enumerated().map {
            TranslationSession.Request(sourceText: $0.element, clientIdentifier: String($0.offset))
        }
        var out = texts
        for response in try await session.translations(from: requests) {
            if let key = response.clientIdentifier, let index = Int(key), index < out.count {
                out[index] = response.targetText
            }
        }
        return (resolved, out)
    }

    private func session(source: String, target: String, requireInstalled: Bool = true) async throws -> TranslationSession {
        let key = "\(source)->\(target)"
        if let existing = sessions[key] { return existing }

        switch await availability(source: source, target: target) {
        case "unsupported":
            throw HostError.bad("Translation from \(source) to \(target) is not supported", code: "unsupported")
        case "supported" where requireInstalled:
            throw HostError.bad(
                "The \(source) to \(target) language pack is not downloaded yet",
                code: "needs_download"
            )
        default:
            break
        }
        let session = TranslationSession(
            installedSource: Locale.Language(identifier: source),
            target: Locale.Language(identifier: target)
        )
        sessions[key] = session
        return session
    }

    private func resolveSource(_ source: String?, texts: [String]) throws -> String {
        guard let source, source != "auto" else {
            let recognizer = NLLanguageRecognizer()
            // Detection is far steadier on one long string than on a hundred
            // fragments, and the whole batch comes off one page anyway.
            recognizer.processString(texts.joined(separator: "\n").prefix(4096).description)
            guard let language = recognizer.dominantLanguage, language != .undetermined else {
                throw HostError.bad("Could not detect the source language", code: "undetected")
            }
            return language.rawValue
        }
        return source
    }
}
