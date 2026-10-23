// Disposable-runner proof observer. No WebKit traversal or UI mutation.
import AppKit
import ApplicationServices
import Foundation
import Vision

struct ProofError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

func readAttributes(_ element: AXUIElement, _ names: [String]) throws -> [String: Any] {
    AXUIElementSetMessagingTimeout(element, 0.75)
    var result: CFArray?
    let error = AXUIElementCopyMultipleAttributeValues(
        element, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &result)
    guard error == .success, let values = result as? [Any], values.count == names.count else {
        throw ProofError("SETUP: Native window metadata AX read failed (\(error.rawValue)); inspect GUI permissions, prompts, or responsiveness")
    }
    var fields: [String: Any] = [:]
    for (name, value) in zip(names, values) {
        let object = value as CFTypeRef
        if CFGetTypeID(object) == AXValueGetTypeID() {
            let ax = unsafeBitCast(object, to: AXValue.self)
            if AXValueGetType(ax) == .axError {
                var embedded = AXError.success
                if AXValueGetValue(ax, .axError, &embedded), embedded == .cannotComplete || embedded == .apiDisabled {
                    throw ProofError("SETUP: Native window metadata attribute \(name) unavailable (\(embedded.rawValue)); no WebKit content was traversed")
                }
                continue // Unsupported optional metadata is not a product failure.
            }
        }
        if !(value is NSNull) { fields[name] = value }
    }
    return fields
}

func geometry(_ value: Any?, position: Bool) -> [Double]? {
    guard let value else { return nil }
    let object = value as CFTypeRef
    guard CFGetTypeID(object) == AXValueGetTypeID() else { return nil }
    let ax = unsafeBitCast(object, to: AXValue.self)
    if position {
        var point = CGPoint.zero
        guard AXValueGetType(ax) == .cgPoint, AXValueGetValue(ax, .cgPoint, &point) else { return nil }
        return [Double(point.x), Double(point.y)]
    }
    var size = CGSize.zero
    guard AXValueGetType(ax) == .cgSize, AXValueGetValue(ax, .cgSize, &size) else { return nil }
    return [Double(size.width), Double(size.height)]
}

func snapshot(_ pid: pid_t) throws -> [String: Any] {
    guard AXIsProcessTrusted() else { throw ProofError("SETUP: Native observer lacks Accessibility permission") }
    guard let process = NSRunningApplication(processIdentifier: pid), !process.isTerminated else {
        throw ProofError("SETUP: Requested packaged app PID is not running")
    }
    let started = ProcessInfo.processInfo.systemUptime
    let attrs = try readAttributes(AXUIElementCreateApplication(pid), [kAXWindowsAttribute])
    let windows = attrs[kAXWindowsAttribute] as? [AXUIElement] ?? []
    guard windows.count <= 32 else { throw ProofError("SETUP: Synthetic fixture exceeds the 32-window metadata bound") }
    var output: [[String: Any]] = []
    for (index, window) in windows.enumerated() {
        guard ProcessInfo.processInfo.systemUptime - started < 8 else { throw ProofError("SETUP: Window-only AX observation exceeded eight seconds") }
        let fields = try readAttributes(window, [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute,
                                                kAXMinimizedAttribute, kAXPositionAttribute, kAXSizeAttribute])
        var bounds: Any = NSNull()
        if let position = geometry(fields[kAXPositionAttribute], position: true),
           let size = geometry(fields[kAXSizeAttribute], position: false) {
            bounds = ["position": position, "size": size]
        }
        output.append(["index": index, "role": fields[kAXRoleAttribute] as? String ?? "",
                       "subrole": fields[kAXSubroleAttribute] as? String ?? "",
                       "title": fields[kAXTitleAttribute] as? String ?? "",
                       "minimized": (fields[kAXMinimizedAttribute] as? NSNumber)?.boolValue as Any? ?? NSNull(),
                       "bounds": bounds])
    }
    return ["frontmost": process.isActive, "windows": output,
            "nativeSnapshot": ["scope": "window-metadata-only", "durationSeconds": ProcessInfo.processInfo.systemUptime - started]]
}

func recognize(_ path: String) throws -> [String: Any] {
    let image = URL(fileURLWithPath: path)
    guard image.pathExtension.lowercased() == "png", FileManager.default.fileExists(atPath: image.path) else {
        throw ProofError("SETUP: --ocr requires an existing synthetic proof PNG")
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-US"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(url: image, options: [:]).perform([request])
    let observations: [[String: Any]] = (request.results ?? []).compactMap { result in
        guard let text = result.topCandidates(1).first else { return nil }
        let bounds = result.boundingBox
        return ["text": text.string, "confidence": Double(text.confidence),
                "bounds": ["x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height]]
    }
    return ["engine": "native-Vision-English-accurate", "image": image.path,
            "text": observations.compactMap { $0["text"] as? String }.joined(separator: "\n"),
            "observations": observations]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    let output: [String: Any]
    if arguments == ["--preflight"] {
        guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else {
            throw ProofError("SETUP: Native observer requires Accessibility and Screen Recording permissions")
        }
        output = ["accessibilityTrusted": AXIsProcessTrusted(), "screenCaptureAllowed": CGPreflightScreenCaptureAccess()]
    } else if arguments.count == 2, arguments[0] == "--ocr" {
        output = try recognize(arguments[1])
    } else if arguments.count == 1, let pid = pid_t(arguments[0]), pid > 0 {
        output = try snapshot(pid)
    } else {
        throw ProofError("SETUP: Usage: ax_snapshot <pid> | --preflight | --ocr <synthetic-PNG>")
    }
    let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch { fail(String(describing: error)) }
