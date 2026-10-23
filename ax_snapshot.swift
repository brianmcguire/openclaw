// Read-only native AX snapshot for disposable Settings-window proof.
// Compile locally if needed; invoke only in the qualified disposable GUI worker.
import AppKit
import ApplicationServices
import Foundation

struct SnapshotFailure: Error, CustomStringConvertible {
    let description: String
}

final class SnapshotReader {
    private let deadline = ProcessInfo.processInfo.systemUptime + 12
    private(set) var nodeCount = 0
    private let requestTimeout: Float = 0.75

    private func checkBudget() throws {
        guard ProcessInfo.processInfo.systemUptime < self.deadline else {
            throw SnapshotFailure(description: "SETUP: Native AX snapshot exceeded its 12-second read budget; target or GUI worker is unresponsive")
        }
    }

    private func check(_ error: AXError, operation: String) throws {
        try self.checkBudget()
        if error == .cannotComplete {
            throw SnapshotFailure(description: "SETUP: Native AX request timed out/could not complete while \(operation); inspect GUI permissions, prompts, and target responsiveness")
        }
        if error == .apiDisabled {
            throw SnapshotFailure(description: "SETUP: Accessibility API is disabled for the native AX snapshot helper")
        }
    }

    private func embeddedError(_ value: Any) -> AXError? {
        let object = value as CFTypeRef
        guard CFGetTypeID(object) == AXValueGetTypeID() else { return nil }
        let axValue = unsafeBitCast(object, to: AXValue.self)
        guard AXValueGetType(axValue) == .axError else { return nil }
        var error = AXError.success
        return AXValueGetValue(axValue, .axError, &error) ? error : nil
    }

    private func attributes(_ element: AXUIElement, names: [String]) throws -> [String: Any] {
        try self.checkBudget()
        let timeoutError = AXUIElementSetMessagingTimeout(element, self.requestTimeout)
        try self.check(timeoutError, operation: "setting the bounded AX request timeout")
        var result: CFArray?
        let error = AXUIElementCopyMultipleAttributeValues(
            element, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &result)
        try self.check(error, operation: "reading \(names.joined(separator: ", "))")
        if error == .invalidUIElement { return [:] } // A changing document may retire a child between reads.
        guard error == .success, let values = result as? [Any], values.count == names.count else {
            throw SnapshotFailure(description: "SETUP: Native AX attribute read failed with code \(error.rawValue)")
        }
        var collected: [String: Any] = [:]
        for (name, value) in zip(names, values) {
            if let error = self.embeddedError(value) {
                try self.check(error, operation: "reading \(name)")
                // Missing/unsupported optional attributes are normal for many AX roles.
                continue
            }
            if !(value is NSNull) { collected[name] = value }
        }
        return collected
    }

    private func text(_ value: Any?) -> String {
        guard let value else { return "" }
        if let url = value as? URL { return url.absoluteString }
        if let text = value as? String { return text }
        if let number = value as? NSNumber { return number.stringValue }
        return ""
    }

    private func point(_ value: Any?) -> [Double]? {
        guard let value else { return nil }
        let object = value as CFTypeRef
        guard CFGetTypeID(object) == AXValueGetTypeID() else { return nil }
        let axValue = unsafeBitCast(object, to: AXValue.self)
        guard AXValueGetType(axValue) == .cgPoint else { return nil }
        var point = CGPoint.zero
        guard AXValueGetValue(axValue, .cgPoint, &point) else { return nil }
        return [Double(point.x), Double(point.y)]
    }

    private func size(_ value: Any?) -> [Double]? {
        guard let value else { return nil }
        let object = value as CFTypeRef
        guard CFGetTypeID(object) == AXValueGetTypeID() else { return nil }
        let axValue = unsafeBitCast(object, to: AXValue.self)
        guard AXValueGetType(axValue) == .cgSize else { return nil }
        var size = CGSize.zero
        guard AXValueGetValue(axValue, .cgSize, &size) else { return nil }
        return [Double(size.width), Double(size.height)]
    }

    private func tree(_ element: AXUIElement, depth: Int = 0) throws -> [String: Any] {
        self.nodeCount += 1
        guard self.nodeCount <= 2500, depth <= 60 else {
            throw SnapshotFailure(description: "SETUP: AX tree exceeded the bounded 2500-node/60-depth synthetic-fixture limit")
        }
        let attrs = try self.attributes(element, names: [
            kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
            kAXValueAttribute, kAXURLAttribute, kAXChildrenAttribute,
        ])
        let children = attrs[kAXChildrenAttribute] as? [AXUIElement] ?? []
        return [
            "role": self.text(attrs[kAXRoleAttribute]),
            "name": self.text(attrs[kAXTitleAttribute]),
            "description": self.text(attrs[kAXDescriptionAttribute]),
            "value": self.text(attrs[kAXValueAttribute]),
            "url": self.text(attrs[kAXURLAttribute]),
            "children": try children.map { try self.tree($0, depth: depth + 1) },
        ]
    }

    func snapshot(pid: pid_t) throws -> [String: Any] {
        guard AXIsProcessTrusted() else {
            throw SnapshotFailure(description: "SETUP: Native AX snapshot helper lacks Accessibility permission; provision the disposable GUI worker without bypassing TCC")
        }
        guard let process = NSRunningApplication(processIdentifier: pid), !process.isTerminated else {
            throw SnapshotFailure(description: "SETUP: Requested packaged app PID is not running")
        }
        let started = ProcessInfo.processInfo.systemUptime
        let application = AXUIElementCreateApplication(pid)
        let attrs = try self.attributes(application, names: [kAXWindowsAttribute])
        let windows = attrs[kAXWindowsAttribute] as? [AXUIElement] ?? []
        var projected: [[String: Any]] = []
        for (index, window) in windows.enumerated() {
            let metadata = try self.attributes(window, names: [
                kAXTitleAttribute, kAXMinimizedAttribute, kAXPositionAttribute, kAXSizeAttribute,
            ])
            var bounds: Any = NSNull()
            if let position = self.point(metadata[kAXPositionAttribute]),
               let size = self.size(metadata[kAXSizeAttribute]) {
                bounds = ["position": position, "size": size]
            }
            projected.append([
                "index": index,
                "title": self.text(metadata[kAXTitleAttribute]),
                "minimized": (metadata[kAXMinimizedAttribute] as? NSNumber)?.boolValue as Any? ?? NSNull(),
                "bounds": bounds,
                "tree": try self.tree(window),
            ])
        }
        return [
            "frontmost": process.isActive,
            "windows": projected,
            "nativeSnapshot": ["nodes": self.nodeCount, "durationSeconds": ProcessInfo.processInfo.systemUptime - started],
        ]
    }
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

if CommandLine.arguments == [CommandLine.arguments[0], "--preflight"] {
    guard AXIsProcessTrusted() else { fail("SETUP: Native AX helper lacks Accessibility permission") }
    print("{\"accessibilityTrusted\":true}")
    exit(0)
}
guard CommandLine.arguments.count == 2, let pid = pid_t(CommandLine.arguments[1]), pid > 0 else {
    fail("SETUP: Usage: ax_snapshot <packaged-app-pid>")
}
do {
    let result = try SnapshotReader().snapshot(pid: pid)
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    fail(String(describing: error))
}
