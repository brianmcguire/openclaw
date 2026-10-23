#!/usr/bin/env python3
"""Proposed native Settings proof driver; only run in a disposable macOS GUI worker.

No app launch, TCC modification, Gateway configuration, or external publication.
Uses actual right mouse events, System Events AX navigation, and window captures.
The runner must launch the packaged app against synthetic loopback data first.
"""
from __future__ import annotations

import argparse
import ctypes
import datetime
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import time
from urllib.parse import urlsplit


class ProofFailure(RuntimeError):
    pass


def run(argv, timeout=35):
    p = subprocess.run(argv, text=True, capture_output=True, timeout=timeout)
    if p.returncode:
        raise ProofFailure(f"{argv[0]} failed ({p.returncode}): {p.stderr.strip()}")
    return p.stdout.strip()


def jxa(body, *, pid=None, timeout=40):
    # Arguments are passed as JSON literals, never interpolated into a shell.
    source = """
ObjC.import('Foundation');
const se = Application('System Events');
function val(e,n) { try { return e.attributes.byName(n).value(); } catch (_) { return null; } }
function txt(v) { return v === null || v === undefined ? '' : String(v); }
function kids(e) { try { return e.uiElements(); } catch (_) { return []; } }
function rect(e) { try { return {position:e.position(), size:e.size()}; } catch (_) { return null; } }
function rec(e) { return {role:txt(val(e,'AXRole')), subrole:txt(val(e,'AXSubrole')),
  name:txt(val(e,'AXTitle')), description:txt(val(e,'AXDescription')),
  help:txt(val(e,'AXHelp')), value:txt(val(e,'AXValue')), url:txt(val(e,'AXURL'))}; }
"""
    if pid is not None:
        source += f"\nconst ps = se.processes.whose({{unixId:{int(pid)}}})();\n"
        source += "if(ps.length!==1) throw Error('Expected exactly one target process'); const p=ps[0];\n"
    source += "\nJSON.stringify((function(){\n" + body + "\n})());\n"
    output = run(["/usr/bin/osascript", "-l", "JavaScript", "-e", source], timeout)
    try:
        return json.loads(output)
    except json.JSONDecodeError as e:
        raise ProofFailure(f"System Events returned non-JSON: {output[:300]}") from e


class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


class Native:
    def __init__(self):
        self.ax = ctypes.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
        self.ax.AXIsProcessTrusted.restype = ctypes.c_bool
        self.cg = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
        self.cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
        self.cg.CGEventCreateMouseEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32]
        self.cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
        self.cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
        self.cg.CGWindowListCopyWindowInfo.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
        self.cg.CGWindowListCopyWindowInfo.restype = ctypes.c_void_p
        self.cg.CGPreflightScreenCaptureAccess.restype = ctypes.c_bool
        self.cf.CFPropertyListCreateData.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long,
                                                   ctypes.c_ulong, ctypes.POINTER(ctypes.c_void_p)]
        self.cf.CFPropertyListCreateData.restype = ctypes.c_void_p
        self.cf.CFDataGetLength.argtypes = [ctypes.c_void_p]
        self.cf.CFDataGetLength.restype = ctypes.c_long
        self.cf.CFDataGetBytePtr.argtypes = [ctypes.c_void_p]
        self.cf.CFDataGetBytePtr.restype = ctypes.POINTER(ctypes.c_ubyte)
        self.cf.CFRelease.argtypes = [ctypes.c_void_p]

    def preflight(self):
        if not self.ax.AXIsProcessTrusted():
            raise ProofFailure('SETUP: Python/runner is not trusted for Accessibility. Provision a permitted disposable GUI worker; do not bypass TCC.')
        if not self.cg.CGPreflightScreenCaptureAccess():
            raise ProofFailure('SETUP: Screen Recording permission is unavailable for this runner. Provision permission before packaging; do not bypass TCC.')
        enabled = jxa("return {uiElementsEnabled:se.uiElementsEnabled(), processes:se.processes().length};")
        if not enabled.get('uiElementsEnabled') or enabled.get('processes', 0) < 1:
            raise ProofFailure('SETUP: No accessible interactive GUI session.')
        return enabled

    def mouse(self, bounds, right):
        if not bounds or len(bounds['position']) != 2 or min(bounds['size']) <= 0:
            raise ProofFailure('Invalid AX bounds for status item')
        x, y = bounds['position']
        w, h = bounds['size']
        point = CGPoint(x + w / 2, y + h / 2)
        # CG coordinates and System Events AX bounds are both top-left screen coordinates.
        # RightMouseDown/Up goes through the app's pointer routing; AXPress does not.
        for event_type in ([3, 4] if right else [1, 2]):
            event = self.cg.CGEventCreateMouseEvent(None, event_type, point, 1 if right else 0)
            if not event:
                raise ProofFailure('Could not allocate mouse event')
            try:
                self.cg.CGEventPost(0, event)
            finally:
                self.cf.CFRelease(event)
            time.sleep(0.08)

    def windows(self, pid):
        info = self.cg.CGWindowListCopyWindowInfo(1 | 16, 0)  # on-screen, exclude desktop
        if not info:
            raise ProofFailure('SETUP: CoreGraphics did not provide window inventory')
        data = None
        try:
            data = self.cf.CFPropertyListCreateData(None, info, 100, 0, None)
            if not data:
                raise ProofFailure('Could not serialize native window inventory')
            raw = ctypes.string_at(self.cf.CFDataGetBytePtr(data), self.cf.CFDataGetLength(data))
            items = plistlib.loads(raw)
            return [w for w in items if w.get('kCGWindowOwnerPID') == pid and w.get('kCGWindowLayer') == 0]
        finally:
            if data:
                self.cf.CFRelease(data)
            self.cf.CFRelease(info)


def snapshot(pid):
    helper = os.environ.get('OPENCLAW_AX_SNAPSHOT_HELPER')
    if not helper or not Path(helper).is_file() or not os.access(helper, os.X_OK):
        raise ProofFailure('SETUP: OPENCLAW_AX_SNAPSHOT_HELPER must name the compiled read-only native AX helper')
    try:
        output = run([helper, str(int(pid))], timeout=16)
    except subprocess.TimeoutExpired as e:
        raise ProofFailure('SETUP: Native AX helper exceeded its bounded request budget; inspect GUI prompts/permissions before evaluating product behavior') from e
    try:
        result = json.loads(output)
    except json.JSONDecodeError as e:
        raise ProofFailure('SETUP: Native AX helper did not return a JSON snapshot') from e
    if not isinstance(result, dict) or not isinstance(result.get('windows'), list):
        raise ProofFailure('SETUP: Native AX helper returned an incompatible snapshot')
    return result


def status_item(pid):
    result = jxa("""
return p.menuBars().map((b,barIndex)=>({barIndex:barIndex,items:b.menuBarItems().map((e,index)=>{
  const r=rec(e); r.index=index; r.bounds=rect(e); return r;
})}));
""", pid=pid)
    candidates = []
    for bar in result:
        for item in bar['items']:
            labels = ' '.join(item.get(k, '') for k in ['name', 'description', 'help', 'value'])
            # App menu title is also OpenClaw. Prefer the separate status menu bar;
            # in a unified bar only a tooltip-bearing, untitled item qualifies.
            status_bar = bar['barIndex'] > 0
            tooltip_only = not item.get('name') and 'OpenClaw' in item.get('help', '')
            if 'OpenClaw' in labels and (status_bar or tooltip_only) and item.get('bounds'):
                candidates.append({'barIndex':bar['barIndex'], **item})
    if len(candidates) != 1:
        raise ProofFailure(f'SETUP: Expected one OpenClaw status item; found {len(candidates)}. AX inventory: {json.dumps(result)}')
    return candidates[0]


def menu_settings(pid, native):
    item = status_item(pid)
    native.mouse(item['bounds'], right=True)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        result = jxa("""
const found=[];
function visit(e, depth) {
 if(depth>7) return;
 const r=rec(e);
 if(r.role==='AXMenuItem' && (r.name==='Settings…' || r.name==='Settings...')) found.push(e);
 kids(e).forEach(x=>visit(x,depth+1));
}
const owner=p.menuBars()[STATUS_BAR].menuBarItems()[STATUS_INDEX];
visit(owner,0);
if(found.length>1) throw Error('Ambiguous Settings menu items');
if(found.length===0) return {clicked:false};
const title=rec(found[0]).name; found[0].click(); return {clicked:true, title:title};
""".replace('STATUS_BAR', str(item['barIndex'])).replace('STATUS_INDEX', str(item['index'])), pid=pid)
        if result['clicked']:
            return result
        time.sleep(0.3)
    raise ProofFailure('Settings item did not appear after actual status-item right-click')


def window_action(pid, index, action):
    # Use standard accessibility window controls, not direct AppKit calls.
    if action == 'close':
        code = "const w=p.windows()[INDEX]; const b=w.buttons.whose({subrole:'AXCloseButton'})(); if(b.length!==1) throw Error('Missing unique Close button'); b[0].click(); return true;"
    elif action == 'minimize':
        code = "const w=p.windows()[INDEX]; const b=w.buttons.whose({subrole:'AXMinimizeButton'})(); if(b.length!==1) throw Error('Missing unique Minimize button'); b[0].click(); return true;"
    else:
        raise ProofFailure('Unsupported window action')
    return jxa(code.replace('INDEX', str(int(index))), pid=pid)


def candidate_windows(state):
    return [w for w in state['windows'] if w.get('subrole') == 'AXStandardWindow'
            and w.get('bounds') and w['bounds']['size'][0] >= 600 and w['bounds']['size'][1] >= 400]


def dashboard_window(pid, timeout=35):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = snapshot(pid)
        candidates = [w for w in candidate_windows(last) if w['minimized'] is False]
        if len(candidates) == 1:
            return last, candidates[0]
        if len(candidates) > 1:
            raise ProofFailure('Fixture has multiple Dashboard windows; expected exactly one')
        time.sleep(0.3)
    raise ProofFailure(f'No unminimized Dashboard AX window: {json.dumps(last)}')


def observe_text(image_path):
    helper = os.environ['OPENCLAW_AX_SNAPSHOT_HELPER']
    return json.loads(run([helper, '--ocr', str(image_path)], timeout=16))


def wait_settings(native, pid, texts, image_path, timeout=40):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        state, window = dashboard_window(pid)
        evidence = {'window': window, 'frontmost': state['frontmost']}
        try:
            image = capture(native, pid, evidence, image_path)
        except ProofFailure as error:
            last = {'visible': False, 'error': str(error), **evidence}
            time.sleep(0.3)
            continue
        try:
            ocr = observe_text(image_path)
        except (ProofFailure, subprocess.TimeoutExpired) as error:
            last = {**evidence, **image, 'observationError':str(error)}
            time.sleep(0.5)
            continue
        matched = [text for text in texts if text.lower() in ocr['text'].lower()]
        last = {**evidence, **image, 'renderedMarkers': matched, 'requiredMarkers': texts,
                'observedText': ocr['text'], 'ocrEngine': ocr['engine'],
                'routeObservation': 'not queried; actual rendered Settings pixels verified'}
        if state['frontmost'] and len(matched) == len(texts):
            return last
        time.sleep(0.4)
    raise ProofFailure(f'Settings did not remain foreground and render its Appearance controls: {json.dumps(last)}')


def capture(native, pid, evidence, path):
    candidates = native.windows(pid)
    bounds = evidence['window']['bounds']
    x, y = bounds['position']; width, height = bounds['size']
    matches = []
    for w in candidates:
        b = w.get('kCGWindowBounds', {})
        if abs(b.get('X', -1) - x) <= 3 and abs(b.get('Y', -1) - y) <= 3 and abs(b.get('Width', -1) - width) <= 3 and abs(b.get('Height', -1) - height) <= 3:
            matches.append(w)
    if len(matches) != 1:
        raise ProofFailure(f'Could not uniquely match visible Dashboard to CGWindow: {json.dumps(candidates)}')
    window_id = matches[0]['kCGWindowNumber']
    run(['/usr/sbin/screencapture', '-x', '-o', '-l', str(window_id), str(path)])
    if not path.is_file() or path.stat().st_size < 500:
        raise ProofFailure('Window screenshot is missing or empty')
    return {'windowId':window_id, 'image':str(path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preflight-only', action='store_true')
    parser.add_argument('--pid', type=int)
    parser.add_argument('--expected-url')
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--settings-text', action='append', help='All visible pixel markers required; defaults Appearance, Theme')
    args = parser.parse_args()
    if sys.platform != 'darwin' or os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_OS') != 'macOS':
        raise ProofFailure('Refusing to drive UI outside an explicitly disposable GitHub Actions macOS worker')
    # This declaration must be set by the workflow after confirming a fresh hosted
    # OS worker. It does not turn an operator machine into a sandbox.
    if os.environ.get('OPENCLAW_DISPOSABLE_GUI_WORKER') != '1':
        raise ProofFailure('Missing disposable GUI worker qualification')
    args.artifacts.mkdir(parents=True, exist_ok=False)
    report = {'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'driver':'actual-native-status-menu-settings', 'cases':[], 'status':'running'}
    report_path = args.artifacts / 'settings-native-proof.json'
    native = Native()
    try:
        report['preflight'] = native.preflight()
        if args.preflight_only:
            report['status'] = 'preflight-passed'
            return
        if not args.pid or not args.expected_url:
            raise ProofFailure('--pid and --expected-url required for live proof')
        expected = urlsplit(args.expected_url)
        if expected.scheme not in ('http', 'https') or expected.hostname not in ('127.0.0.1', 'localhost', '::1') or expected.username or expected.password:
            raise ProofFailure('Expected Settings URL must use credential-free synthetic loopback origin')
        texts = args.settings_text or ['Appearance', 'Theme']
        report['pid'] = args.pid
        report['expectedUrl'] = args.expected_url
        startup_deadline = time.monotonic() + 30
        while True:
            try:
                report['initialStatusItem'] = status_item(args.pid)
                break
            except ProofFailure as startup_error:
                if time.monotonic() >= startup_deadline:
                    raise ProofFailure(f'SETUP: App status item did not become ready: {startup_error}') from startup_error
                time.sleep(0.25)
        for case in ['existing', 'closed', 'minimized', 'command-comma']:
            if case == 'existing':
                native.mouse(status_item(args.pid)['bounds'], right=False)
                first, current = dashboard_window(args.pid)
                # Confirm the owned Dashboard actually paints before testing Settings.
                render_deadline = time.monotonic() + 60
                while True:
                    initial_image = args.artifacts / 'before-settings.png'
                    capture(native, args.pid, {'window': current}, initial_image)
                    try:
                        initial_text = observe_text(initial_image)['text']
                    except (ProofFailure, subprocess.TimeoutExpired) as error:
                        report['initialObservationError'] = str(error)
                        initial_text = ''
                    if len(initial_text.strip()) > 12:
                        report['initialDashboardText'] = initial_text
                        break
                    if time.monotonic() >= render_deadline:
                        raise ProofFailure(f"SETUP: Initial Dashboard did not yield readable content before Settings; inspect before-settings.png; last observer error: {report.get('initialObservationError', 'none')}")
                    time.sleep(0.5)
                    first, current = dashboard_window(args.pid)
            elif case == 'closed':
                state, current = dashboard_window(args.pid)
                window_action(args.pid, current['index'], 'close')
                deadline = time.monotonic() + 8
                while candidate_windows(snapshot(args.pid)) and time.monotonic() < deadline:
                    time.sleep(0.2)
                if candidate_windows(snapshot(args.pid)):
                    raise ProofFailure('Closed precondition failed: Dashboard AX window remains')
            elif case == 'minimized':
                state, current = dashboard_window(args.pid)
                window_action(args.pid, current['index'], 'minimize')
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    if any(w.get('minimized') is True for w in snapshot(args.pid)['windows']):
                        break
                    time.sleep(0.2)
                else:
                    raise ProofFailure('Minimized precondition failed')
            if case == 'command-comma':
                state, current = dashboard_window(args.pid)
                window_action(args.pid, current['index'], 'close')
                time.sleep(0.4)
                native.mouse(status_item(args.pid)['bounds'], right=False)
                dashboard_window(args.pid)
                jxa("p.frontmost=true; se.keystroke(',', {using:['command down']}); return true;", pid=args.pid)
                entry = {'keyboard':'command-comma'}
            else:
                entry = menu_settings(args.pid, native)
            report['activeCase'] = case
            report['lastEntrypoint'] = entry
            report_path.write_text(json.dumps(report, indent=2))
            image_path = args.artifacts / f'{case}.png'
            evidence = wait_settings(native, args.pid, texts, image_path)
            # A flashing window is not success: require the same Settings surface
            # to remain visible/unminimized through a second independent observation.
            time.sleep(2)
            stable = wait_settings(native, args.pid, texts, image_path, timeout=10)
            if stable['windowId'] != evidence['windowId']:
                raise ProofFailure('Settings native window changed during stability observation')
            desktop_path = args.artifacts / f'{case}-desktop.png'
            run(['/usr/sbin/screencapture', '-x', '-m', str(desktop_path)])
            report['cases'].append({'case':case, 'entrypoint':entry, 'desktopImage':str(desktop_path), **stable})
            report_path.write_text(json.dumps(report, indent=2))
        report['status'] = 'passed'
    except Exception as e:
        report['status'] = 'failed'
        report['error'] = str(e)
        try:
            # This worker has already been qualified as disposable and synthetic.
            # Preserve the failed/no-window surface as proof rather than fabricate a crop.
            failure_image = args.artifacts / 'failure-desktop.png'
            run(['/usr/sbin/screencapture', '-x', '-m', str(failure_image)])
            report['failureImage'] = str(failure_image)
        except Exception as capture_error:
            report['failureCaptureError'] = str(capture_error)
        raise
    finally:
        report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        report_path.write_text(json.dumps(report, indent=2))
        print(json.dumps({'status':report['status'], 'report':str(report_path), 'completedCases':len(report['cases'])}))


if __name__ == '__main__':
    try:
        main()
    except (ProofFailure, subprocess.TimeoutExpired) as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
