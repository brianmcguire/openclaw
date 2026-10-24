import AppKit
import WebKit
import Foundation

// Standalone synthetic page. Compile anywhere; execute only on a fresh CI desktop.
final class Canary: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    func applicationDidFinishLaunching(_ note: Notification) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 900, height: 620),
                          styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Synthetic isolated desktop check"
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.loadHTMLString("<html><body style='background:#e8f5ff;color:#123456;font:32px sans-serif;padding:50px'><h1>Isolated desktop ready</h1><p>WebKit rendering check</p><p>Synthetic data only</p></body></html>", baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 35) { self.finish(error: "WebKit navigation deadline exceeded") }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.finish(error: nil) }
    }
    func finish(error: String?) {
        let image = output.appendingPathComponent("desktop-canary.png")
        let capture = Process()
        capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        capture.arguments = ["-x", "-o", "-l", String(window.windowNumber), image.path]
        do { try capture.run(); capture.waitUntilExit() } catch { fputs("Canary capture failed: \(error)\n", stderr); exit(1) }
        let report: [String: Any] = ["navigationFinished": error == nil, "error": error as Any? ?? NSNull(),
                                   "windowId": window.windowNumber, "image": image.path,
                                   "captureExit": capture.terminationStatus]
        let data = try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        try! data.write(to: output.appendingPathComponent("desktop-canary.json"))
        exit(error == nil && capture.terminationStatus == 0 ? 0 : 1)
    }
}
guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true",
      ProcessInfo.processInfo.environment["RUNNER_ENVIRONMENT"] == "github-hosted",
      ProcessInfo.processInfo.environment["GITHUB_REPOSITORY"] == "brianmcguire/openclaw",
      CommandLine.arguments.count == 2 else { fatalError("Disposable hosted desktop required") }
let delegate = Canary()
let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
