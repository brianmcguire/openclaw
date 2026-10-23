#!/usr/bin/env python3
"""Deny only observed Local Network consent in a disposable hosted proof worker.

Never grants permission, writes TCC, emits keys, or descends into WebKit. This is
setup handling, not a product assertion. The caller owns this watcher process.
"""
import argparse
import ctypes as C
import json
import os
import plistlib
import re
import sys
import time


class Pair(C.Structure):
    _fields_ = [('a', C.c_double), ('b', C.c_double)]


class AX:
    def __init__(self):
        self.cf = C.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
        self.ax = C.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
        self.cg = C.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
        self.cf.CFRelease.argtypes = [C.c_void_p]
        self.cf.CFStringCreateWithCString.argtypes = [C.c_void_p, C.c_char_p, C.c_uint32]
        self.cf.CFStringCreateWithCString.restype = C.c_void_p
        self.cf.CFStringGetCString.argtypes = [C.c_void_p, C.c_char_p, C.c_long, C.c_uint32]
        self.cf.CFStringGetCString.restype = C.c_bool
        self.cf.CFGetTypeID.argtypes = [C.c_void_p]
        self.cf.CFGetTypeID.restype = C.c_ulong
        self.cf.CFStringGetTypeID.restype = C.c_ulong
        self.cf.CFArrayGetTypeID.restype = C.c_ulong
        self.cf.CFArrayGetCount.argtypes = [C.c_void_p]
        self.cf.CFArrayGetCount.restype = C.c_long
        self.cf.CFArrayGetValueAtIndex.argtypes = [C.c_void_p, C.c_long]
        self.cf.CFArrayGetValueAtIndex.restype = C.c_void_p
        self.cf.CFRetain.argtypes = [C.c_void_p]
        self.ax.AXUIElementCreateApplication.argtypes = [C.c_int]
        self.ax.AXUIElementCreateApplication.restype = C.c_void_p
        self.ax.AXUIElementSetMessagingTimeout.argtypes = [C.c_void_p, C.c_float]
        self.ax.AXUIElementCopyAttributeValue.argtypes = [C.c_void_p, C.c_void_p, C.POINTER(C.c_void_p)]
        self.ax.AXUIElementPerformAction.argtypes = [C.c_void_p, C.c_void_p]
        self.ax.AXValueGetValue.argtypes = [C.c_void_p, C.c_int, C.c_void_p]
        self.ax.AXValueGetValue.restype = C.c_bool
        self.cg.CGWindowListCopyWindowInfo.argtypes = [C.c_uint32, C.c_uint32]
        self.cg.CGWindowListCopyWindowInfo.restype = C.c_void_p
        self.cf.CFPropertyListCreateData.argtypes = [C.c_void_p, C.c_void_p, C.c_long, C.c_ulong, C.c_void_p]
        self.cf.CFPropertyListCreateData.restype = C.c_void_p
        self.cf.CFDataGetLength.argtypes = [C.c_void_p]
        self.cf.CFDataGetLength.restype = C.c_long
        self.cf.CFDataGetBytePtr.argtypes = [C.c_void_p]
        self.cf.CFDataGetBytePtr.restype = C.c_void_p
        self.keys = {}

    def key(self, text):
        if text not in self.keys:
            self.keys[text] = self.cf.CFStringCreateWithCString(None, text.encode(), 0x08000100)
        return self.keys[text]

    def attr(self, element, key):
        value = C.c_void_p()
        return value.value if self.ax.AXUIElementCopyAttributeValue(element, self.key(key), C.byref(value)) == 0 else None

    def text(self, element, key):
        value = self.attr(element, key)
        if not value:
            return ''
        try:
            if self.cf.CFGetTypeID(value) != self.cf.CFStringGetTypeID():
                return ''
            buf = C.create_string_buffer(8192)
            return buf.value.decode('utf-8') if self.cf.CFStringGetCString(value, buf, len(buf), 0x08000100) else ''
        finally:
            self.cf.CFRelease(value)

    def elements(self, element, key, limit):
        value = self.attr(element, key)
        if not value:
            return []
        result = []
        try:
            if self.cf.CFGetTypeID(value) != self.cf.CFArrayGetTypeID():
                return []
            count = self.cf.CFArrayGetCount(value)
            if count > limit:
                return []
            for i in range(count):
                child = self.cf.CFArrayGetValueAtIndex(value, i)
                self.cf.CFRetain(child)
                result.append(child)
            return result
        finally:
            self.cf.CFRelease(value)

    def size(self, element):
        value = self.attr(element, 'AXSize')
        if not value:
            return None
        try:
            pair = Pair()
            return (pair.a, pair.b) if self.ax.AXValueGetValue(value, 2, C.byref(pair)) else None
        finally:
            self.cf.CFRelease(value)

    def candidate_owners(self):
        windows = self.cg.CGWindowListCopyWindowInfo(1 | 16, 0)
        if not windows:
            return {}
        data = None
        try:
            data = self.cf.CFPropertyListCreateData(None, windows, 100, 0, None)
            if not data:
                return {}
            items = plistlib.loads(C.string_at(self.cf.CFDataGetBytePtr(data), self.cf.CFDataGetLength(data)))
            owners = {}
            for item in items:
                b = item.get('kCGWindowBounds', {})
                # System consent is a small native window. Never inspect full
                # dashboard, browser, terminal, or desktop trees.
                if (180 <= b.get('Width', 0) <= 700 and 100 <= b.get('Height', 0) <= 550
                        and item.get('kCGWindowAlpha', 1) > 0):
                    owners[item['kCGWindowOwnerPID']] = item.get('kCGWindowOwnerName', '')
            return owners
        finally:
            if data:
                self.cf.CFRelease(data)
            self.cf.CFRelease(windows)

    def deny_matching_alert(self, pid, owner):
        app = self.ax.AXUIElementCreateApplication(pid)
        self.ax.AXUIElementSetMessagingTimeout(app, 0.15)
        windows = self.elements(app, 'AXWindows', 10)
        try:
            for window in windows:
                size = self.size(window)
                if not size or not (180 <= size[0] <= 700 and 100 <= size[1] <= 550):
                    continue
                texts, denies, allows, visited = [], [], [], [0]
                def walk(element, depth):
                    if depth > 6 or visited[0] >= 100:
                        return
                    visited[0] += 1
                    role = self.text(element, 'AXRole')
                    if role in ('AXWebArea', 'AXBrowser', 'AXHTMLContent'):
                        return
                    title = self.text(element, 'AXTitle')
                    texts.extend([title, self.text(element, 'AXDescription'), self.text(element, 'AXValue')])
                    if role == 'AXButton':
                        normalized = title.replace('\u2019', "'")
                        if normalized == "Don't Allow":
                            self.cf.CFRetain(element)
                            denies.append(element)
                        elif title == 'Allow':
                            allows.append(True)
                    children = self.elements(element, 'AXChildren', 35)
                    try:
                        for child in children:
                            walk(child, depth + 1)
                    finally:
                        for child in children:
                            self.cf.CFRelease(child)
                try:
                    walk(window, 0)
                    text = ' '.join(' '.join(texts).split())
                    # Match the exact observed permission request and only the
                    # synthetic command-host/app names expected by this harness.
                    request = re.search(r'''Allow [\u201c"']?(hosted-compute-[\w.-]*|OpenClaw|bun)[\u201d"']? to find devices on local networks\?''', text)
                    if request and len(denies) == 1 and len(allows) == 1:
                        result = self.ax.AXUIElementPerformAction(denies[0], self.key('AXPress'))
                        if result != 0:
                            raise RuntimeError(f'AXPress denial failed with code {result}')
                        return {'event': 'denied-local-network', 'pid': pid, 'owner': owner,
                                'requestor': request.group(1), 'action': "Don't Allow"}
                finally:
                    for element in denies:
                        self.cf.CFRelease(element)
            return None
        finally:
            for window in windows:
                self.cf.CFRelease(window)
            self.cf.CFRelease(app)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=float, default=180)
    args = parser.parse_args()
    if not (sys.platform == 'darwin' and os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted'
            and os.environ.get('RUNNER_OS') == 'macOS'
            and os.environ.get('GITHUB_REPOSITORY') == 'brianmcguire/openclaw'
            and os.environ.get('OPENCLAW_DISPOSABLE_GUI_WORKER') == '1'):
        raise RuntimeError('Refusing permission UI handling outside disposable hosted proof worker')
    if not 0 < args.seconds <= 600:
        raise RuntimeError('Watcher duration must be between 0 and 600 seconds')
    ax = AX()
    deadline = time.monotonic() + args.seconds
    denied = 0
    print(json.dumps({'event': 'watching-local-network-only', 'seconds': args.seconds}), flush=True)
    while time.monotonic() < deadline:
        for pid, owner in ax.candidate_owners().items():
            event = ax.deny_matching_alert(pid, owner)
            if event:
                denied += 1
                print(json.dumps(event), flush=True)
                time.sleep(0.3)
        time.sleep(0.5)
    print(json.dumps({'event': 'watch-finished', 'denied': denied}), flush=True)


if __name__ == '__main__':
    main()
