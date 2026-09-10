// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "translator-host",
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(
            name: "translator-host",
            path: "Sources/translator-host",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
