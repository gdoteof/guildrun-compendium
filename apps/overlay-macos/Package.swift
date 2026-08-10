// swift-tools-version: 5.9
import PackageDescription

// A plain executable, deliberately: no Xcode project, no .app bundle, no
// storyboards. The window is the entire reason this target exists — everything
// it displays is the companion's existing web UI in a WKWebView.
let package = Package(
    name: "guildrun-overlay",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "GuildrunOverlay", path: "Sources/GuildrunOverlay"),
    ]
)
