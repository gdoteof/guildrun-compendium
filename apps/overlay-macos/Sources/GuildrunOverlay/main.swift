/**
 * Guildrun Overlay (macOS) — the Belly panel, floating over the game.
 *
 * Why this exists at all: a browser window, including Chrome's document
 * picture-in-picture, is always-on-top only WITHIN a Space. macOS native
 * fullscreen puts the game in its own Space, and a window that hasn't opted
 * into joining every Space simply is not there when you switch to it. That
 * opt-in is a window-server property with no web equivalent — hence ~250 lines
 * of AppKit, and nothing more:
 *
 *   level                = .screenSaver        above normal and floating windows
 *   collectionBehavior   = .canJoinAllSpaces   rides into the game's Space
 *                        + .stationary         doesn't slide during Space swaps
 *                        + .fullScreenAuxiliary
 *   .nonactivatingPanel  never takes focus or keystrokes from the game
 *   ignoresMouseEvents   optional click-through, toggled from the menu bar
 *
 * Everything shown is the companion's own page (/belly?overlay=1) in a
 * WKWebView, so the belly logic, layout and live SSE stream have exactly one
 * implementation. This target adds no game interaction of any kind: it reads
 * nothing, writes nothing, and injects nothing. It is a window.
 */

import AppKit
import WebKit

// ---------------------------------------------------------------- arguments

struct Options {
    var url = "http://127.0.0.1:4646/belly?overlay=1"
    var width: CGFloat = 380
    var height: CGFloat = 520
    var opacity: CGFloat = 1.0

    static func parse(_ argv: [String]) -> Options {
        var o = Options()
        func value(_ name: String) -> String? {
            guard let i = argv.firstIndex(of: "--\(name)"), i + 1 < argv.count else { return nil }
            return argv[i + 1]
        }
        if let port = value("port") { o.url = "http://127.0.0.1:\(port)/belly?overlay=1" }
        if let url = value("url") { o.url = url }
        if let w = value("width").flatMap(Double.init) { o.width = w }
        if let h = value("height").flatMap(Double.init) { o.height = h }
        if let a = value("opacity").flatMap(Double.init) { o.opacity = max(0.2, min(1.0, a)) }
        return o
    }
}

let options = Options.parse(Array(CommandLine.arguments.dropFirst()))

if CommandLine.arguments.contains("--help") {
    print("""
    guildrun-overlay — Niklas' Belly, floating over the game

      --port <n>       companion port (default 4646)
      --url <url>      full URL instead of the default /belly?overlay=1
      --width <px>     panel width  (default 380)
      --height <px>    panel height (default 520)
      --opacity <0-1>  panel opacity (default 1.0)

    Needs the companion running. Menu bar icon toggles click-through and hiding.
    """)
    exit(0)
}

// ------------------------------------------------------------------- panel

/// Borderless, non-activating panel that follows the game into fullscreen.
final class OverlayPanel: NSPanel {
    init(size: NSSize) {
        super.init(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel, .resizable],
            backing: .buffered,
            defer: false
        )
        // ORDER MATTERS: isFloatingPanel's setter forces level to .floating (3),
        // which sits below a fullscreen game's own windows. Set it first, then
        // raise the level, or the panel silently ends up in the wrong place —
        // verify with CGWindowListCopyWindowInfo, whose layer must read 1000.
        isFloatingPanel = true
        level = .screenSaver

        // present in every Space, including the one a fullscreen game occupies
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]

        becomesKeyOnlyIfNeeded = true      // clicking it must not steal the game's input
        hidesOnDeactivate = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovableByWindowBackground = true
        setFrameAutosaveName("NiklasBellyOverlay")   // remembers where you put it
    }

    // a borderless window refuses key status by default; allow it only so the
    // web view can be scrolled, never taking activation from the game
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// A view in an inactive window normally swallows the first click just to
/// activate. This overlay is never active — the game is — so without this the
/// first grab of every drag would be eaten.
final class HUDWebView: WKWebView {
    override func acceptsFirstMouse(for _: NSEvent?) -> Bool { true }
}

// ---------------------------------------------------------------- dragging

/**
 * A HUD has no title bar to grab, so the page itself reports the start of a
 * drag and AppKit moves the window.
 *
 * Doing it this way rather than with a transparent catcher view over the web
 * view keeps everything else the page can do intact — scrolling, hover, links —
 * because only a left press on non-interactive content is claimed. (AppKit's
 * own isMovableByWindowBackground never fires here: the web view consumes the
 * mouse events before the window sees them.)
 */
let DRAG_SCRIPT = """
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('a, button, input, select, textarea')) return;
  e.preventDefault();
  window.webkit.messageHandlers.drag.postMessage({});
});
document.documentElement.style.cursor = 'grab';
"""

// --------------------------------------------------------------- app logic

final class Overlay: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private let panel: OverlayPanel
    private let webView: HUDWebView
    private var statusItem: NSStatusItem!
    private var clickThrough = false
    private var retry: Timer?
    private var dragMonitor: Any?

    override init() {
        panel = OverlayPanel(size: NSSize(width: options.width, height: options.height))

        // the page tells us when a drag starts; see DRAG_SCRIPT
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.addUserScript(
            WKUserScript(source: DRAG_SCRIPT, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
        config.userContentController = controller
        webView = HUDWebView(frame: .zero, configuration: config)
        super.init()
        controller.add(self, name: "drag")

        // A true HUD: no material, no backing, no chrome — the game shows
        // through everywhere the page hasn't drawn a glyph. Legibility is the
        // page's job (text shadows), not a panel's.
        let root = NSView(frame: NSRect(origin: .zero,
                                        size: NSSize(width: options.width, height: options.height)))
        root.autoresizingMask = [.width, .height]

        webView.frame = root.bounds
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")   // transparent to the game below
        root.addSubview(webView)

        panel.contentView = root
        panel.hasShadow = false      // a shadow around empty space looks like a window
        panel.alphaValue = options.opacity
    }

    func applicationDidFinishLaunching(_: Notification) {
        // agent app: no Dock icon, no menu bar, nothing to alt-tab into
        NSApp.setActivationPolicy(.accessory)

        if panel.frame.origin == .zero, let screen = NSScreen.main {
            let visible = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: visible.maxX - options.width - 24,
                                         y: visible.maxY - options.height - 24))
        }
        panel.orderFrontRegardless()   // show without activating this app
        load()
        buildMenu()

        // the two properties this whole target exists for — printed so a bad
        // build is obvious without attaching a debugger (level must be 1000;
        // AppKit setters have been known to quietly reset it)
        print("""
        Guildrun Overlay
          url     \(options.url)
          level   \(panel.level.rawValue) (expected 1000)
          spaces  canJoinAllSpaces=\(panel.collectionBehavior.contains(.canJoinAllSpaces))
          menu    the 🍖 in the menu bar: click-through, opacity, hide, quit
        """)
        fflush(stdout)   // long-lived process: stdout to a pipe is block-buffered
    }

    private func load() {
        guard let url = URL(string: options.url) else {
            FileHandle.standardError.write(Data("bad --url: \(options.url)\n".utf8))
            exit(1)
        }
        webView.load(URLRequest(url: url))
    }

    /// The companion may not be up yet (or may be restarting) — keep trying
    /// quietly rather than sitting on an error page.
    func webView(_: WKWebView, didFail _: WKNavigation!, withError _: Error) { scheduleRetry() }
    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError _: Error) {
        scheduleRetry()
    }

    private func scheduleRetry() {
        retry?.invalidate()
        retry = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            self?.load()
        }
    }

    // ----------------------------------------------------------- dragging

    func userContentController(_: WKUserContentController, didReceive _: WKScriptMessage) {
        beginDrag()
    }

    /// Move the window with the mouse until the button comes up. A local
    /// monitor is enough: a non-activating panel still receives its own mouse
    /// events, and this needs no accessibility permission (a global monitor
    /// would).
    private func beginDrag() {
        guard dragMonitor == nil else { return }
        let startMouse = NSEvent.mouseLocation
        let startOrigin = panel.frame.origin
        NSCursor.closedHand.push()

        dragMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDragged, .leftMouseUp]) {
            [weak self] event in
            guard let self else { return event }
            if event.type == .leftMouseUp {
                self.endDrag()
            } else {
                let now = NSEvent.mouseLocation
                self.panel.setFrameOrigin(NSPoint(x: startOrigin.x + (now.x - startMouse.x),
                                                  y: startOrigin.y + (now.y - startMouse.y)))
            }
            return event
        }
    }

    private func endDrag() {
        if let monitor = dragMonitor { NSEvent.removeMonitor(monitor) }
        dragMonitor = nil
        NSCursor.pop()
        panel.saveFrame(usingName: "NiklasBellyOverlay")
    }

    // ----------------------------------------------------------- menu bar

    private func buildMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "🍖"
        statusItem.button?.toolTip = "Niklas' Belly overlay"

        let menu = NSMenu()
        menu.addItem(item("Hide overlay", #selector(toggleVisible), "h"))
        menu.addItem(item("Click-through", #selector(toggleClickThrough), "t"))
        menu.addItem(item("Dim backdrop", #selector(toggleScrim), "d"))
        menu.addItem(.separator())
        for percent in [100, 85, 70, 55] {
            let entry = item("Opacity \(percent)%", #selector(setOpacity(_:)), "")
            entry.tag = percent
            entry.state = Int(options.opacity * 100) == percent ? .on : .off
            menu.addItem(entry)
        }
        menu.addItem(.separator())
        menu.addItem(item("Reload", #selector(reload), "r"))
        menu.addItem(item("Quit", #selector(quit), "q"))
        statusItem.menu = menu
    }

    private func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.target = self
        return entry
    }

    @objc private func toggleVisible(_ sender: NSMenuItem) {
        if panel.isVisible {
            panel.orderOut(nil)
            sender.title = "Show overlay"
        } else {
            panel.orderFrontRegardless()
            sender.title = "Hide overlay"
        }
    }

    /// Click-through: the panel stops taking any mouse input, so clicks and
    /// drags land on the game underneath as if it weren't there.
    @objc private func toggleClickThrough(_ sender: NSMenuItem) {
        clickThrough.toggle()
        panel.ignoresMouseEvents = clickThrough
        sender.state = clickThrough ? .on : .off
    }

    /// Pure HUD is unreadable over some art; this dims what's behind the text.
    /// The page owns the styling, so it's one class toggle away.
    @objc private func toggleScrim(_ sender: NSMenuItem) {
        sender.state = sender.state == .on ? .off : .on
        webView.evaluateJavaScript("document.body.classList.toggle('scrim')")
    }

    @objc private func setOpacity(_ sender: NSMenuItem) {
        panel.alphaValue = CGFloat(sender.tag) / 100
        sender.menu?.items.forEach { if $0.action == #selector(setOpacity(_:)) { $0.state = .off } }
        sender.state = .on
    }

    @objc private func reload() { load() }
    @objc private func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let overlay = Overlay()
app.delegate = overlay
app.run()
