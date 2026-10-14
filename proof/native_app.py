"""Disposable Actions-only app proof. Never run this on an operator Mac.

Exercises the real app's authenticated native exec socket, approval evaluator,
CommandResolver and subprocess owner. It does not emulate Gateway transport.
The candidate is an ad-hoc development bundle, not a signed release upgrade.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import uuid

assert sys.platform == "darwin"
assert os.environ.get("GITHUB_ACTIONS") == "true"
assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
assert os.environ.get("GITHUB_REPOSITORY") == "brianmcguire/openclaw"
candidate = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
out.mkdir(exist_ok=True)
home_dir = Path.home()
state = home_dir / ".openclaw"
assert not state.exists(), "Expected a credentialless disposable runner"
app = Path("/Applications/OpenClaw.app")
assert not app.exists(), "Refuse to replace a pre-existing app"
tool = home_dir / ".local/bin/openclaw-path-proof"
assert not tool.exists()
tool.parent.mkdir(parents=True, exist_ok=True)
tool.write_text('#!/bin/sh\nprintf "OPENCLAW_PATH_PROOF_OK\\n"\n')
tool.chmod(0o755)
results = {"candidateHead": "564e4b3f47709783ad44cf3742f889c105da86fb",
           "stable": "2026.10.3", "boundary": "authenticated native exec socket",
           "candidatePackaging": "debug, ad hoc, MLX helper omitted", "cases": []}
owned_pid = None


def run(args, **kw):
    return subprocess.run([str(a) for a in args], check=True, text=True,
                          capture_output=True, timeout=180, **kw).stdout


def record(value):
    # No credentials, environment dumps or operator data enter the artifact.
    text = json.dumps(value).replace(str(home_dir), "<runner-home>")
    results["cases"].append(json.loads(text))
    (out / "native-results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(text, flush=True)


def wait_socket():
    database = state / "state/openclaw.sqlite"
    deadline = time.monotonic() + 120
    last_error = "not created"
    while time.monotonic() < deadline:
        try:
            with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
                row = db.execute("SELECT raw_json FROM exec_approvals_config "
                                 "WHERE config_key='current'").fetchone()
            document = json.loads(row[0])
            credentials = document["socket"]
            if Path(credentials["path"]).exists():
                return document
        except (sqlite3.Error, TypeError, KeyError, FileNotFoundError) as exc:
            last_error = type(exc).__name__
        time.sleep(0.5)
    raise RuntimeError(f"Native app socket unavailable: {last_error}")


def exec_request(command):
    credentials = wait_socket()["socket"]
    request = {"command": command, "cwd": str(home_dir), "timeoutMs": 5000,
               "agentId": "path-proof"}
    request_json = json.dumps(request, separators=(",", ":"))
    nonce = uuid.uuid4().hex
    timestamp = int(time.time() * 1000)
    signature = hmac.new(credentials["token"].encode(),
                         f"{nonce}:{timestamp}:{request_json}".encode(),
                         hashlib.sha256).hexdigest()
    envelope = {"type": "exec", "id": uuid.uuid4().hex, "nonce": nonce,
                "ts": timestamp, "hmac": signature, "requestJson": request_json}
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(20)
        conn.connect(credentials["path"])
        conn.sendall(json.dumps(envelope).encode() + b"\n")
        with conn.makefile("rb") as stream:
            return json.loads(stream.readline(1_000_000))


def app_pid():
    matches = run(["/bin/ps", "-axo", "pid=,comm="])
    for line in matches.splitlines():
        pieces = line.strip().split(None, 1)
        if len(pieces) == 2 and pieces[1] == str(app / "Contents/MacOS/OpenClaw"):
            return int(pieces[0])
    raise RuntimeError("Launched app process not found")


def launch(name):
    global owned_pid
    run(["/bin/launchctl", "setenv", "PATH", "/usr/bin:/bin:/usr/sbin:/sbin"])
    run(["/usr/bin/open", "-n", "-a", app, "--args", "--attach-only", "--no-activate"])
    wait_socket()
    owned_pid = app_pid()
    process = run(["/bin/ps", "eww", "-p", str(owned_pid), "-o", "command="])
    match = re.search(r"(?:^| )PATH=([^ ]+)", process)
    if not match:
        raise RuntimeError("Could not verify inherited app PATH")
    inherited_path = match.group(1)
    assert str(tool.parent) not in inherited_path.split(":"), inherited_path
    record({"name": name + "-launchservices", "pid": owned_pid,
            "inheritedPath": inherited_path})


def stop():
    global owned_pid
    if owned_pid is None:
        return
    os.kill(owned_pid, 15)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            os.kill(owned_pid, 0)
        except ProcessLookupError:
            owned_pid = None
            return
        time.sleep(0.25)
    raise RuntimeError("App did not exit cleanly")


def check(name, expect_success):
    response = exec_request([tool.name])
    payload = response.get("payload", {})
    success = response.get("ok") is True and payload.get("success") is True
    record({"name": name, "response": response})
    assert success == expect_success, name
    if success:
        assert payload["exitCode"] == 0
        assert payload["stdout"] == "OPENCLAW_PATH_PROOF_OK\n"


try:
    dmg = out.parent / "stable-openclaw.dmg"
    url = ("https://github.com/openclaw/openclaw/releases/download/v2026.10.3/"
           "OpenClaw-2026.10.3-arm64.dmg")
    run(["/usr/bin/curl", "--fail", "--location", "--output", dmg, url])
    mount = out.parent / "stable-mount"
    mount.mkdir(exist_ok=True)
    run(["/usr/bin/hdiutil", "attach", dmg, "-nobrowse", "-readonly", "-mountpoint", mount])
    try:
        run(["/usr/bin/ditto", mount / "OpenClaw.app", app])
    finally:
        run(["/usr/bin/hdiutil", "detach", mount])
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app])
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    assert info["CFBundleShortVersionString"] == "2026.10.3"
    for key, value in [("openclaw.swabbleEnabled", "false"),
                       ("openclaw.computerControlEnabled", "false"),
                       ("openclaw.cookieSyncEnabled", "false"),
                       ("SUEnableAutomaticChecks", "false")]:
        run(["/usr/bin/defaults", "write", "ai.openclaw.mac", key, "-bool", value])
    run(["/usr/bin/defaults", "write", "ai.openclaw.mac",
         "openclaw.voiceWakeLocaleID", "-string", "en-GB"])
    launch("stable")
    stop()
    # Import policy using the shipped stable CLI while its native app is stopped.
    runtime = app / "Contents/Resources/runtime"
    cli = [runtime / "bin/bun", runtime / "lib/node_modules/openclaw/openclaw.mjs"]
    policy = out.parent / "path-proof-policy.json"
    policy.write_text(json.dumps({"version": 1,
        "defaults": {"security": "allowlist", "ask": "off", "autoAllowSkills": False},
        "agents": {"path-proof": {"allowlist": [{"pattern": str(tool)}]}}}))
    cli_env = dict(os.environ)
    cli_env["OPENCLAW_SQLITE_LIBRARY"] = str(runtime / "lib/libsqlite3.dylib")
    run(cli + ["approvals", "set", "--file", policy], env=cli_env)
    launch("stable-policy")
    check("stable-launchservices-bare-tool", False)
    control = exec_request([str(tool)])
    record({"name": "stable-absolute-control", "response": control})
    assert control.get("payload", {}).get("success") is True
    before_policy = wait_socket()
    stop()
    # Replace only this job-owned app bundle. Settings and state remain in place.
    shutil.rmtree(app)
    run(["/usr/bin/ditto", candidate, app])
    launch("candidate")
    check("candidate-launchservices-bare-tool", True)
    after_policy = wait_socket()
    assert before_policy["defaults"] == after_policy["defaults"]
    assert before_policy["socket"] == after_policy["socket"]
    assert run(["/usr/bin/defaults", "read", "ai.openclaw.mac",
                "openclaw.voiceWakeLocaleID"]).strip() == "en-GB"
    record({"name": "stable-to-development-replacement-settings",
            "policyPreserved": True, "socketCredentialsPreserved": True,
            "voiceLocalePreserved": True,
            "scope": "manual development app replacement, not signed updater or Keychain migration"})
    stop()
    # The shipped login plist uses this executable, RunAtLoad, and preferred PATH.
    # Bootstrap a job with that structure. This does not claim an OS logout/login.
    label = "ai.openclaw.mac.path-proof"
    agent = out.parent / "path-proof-login.plist"
    login_path = ":".join(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", str(tool.parent)])
    agent.write_bytes(plistlib.dumps({"Label": label,
        "ProgramArguments": [str(app / "Contents/MacOS/OpenClaw"), "--attach-only", "--no-activate"],
        "WorkingDirectory": str(home_dir), "RunAtLoad": True,
        "EnvironmentVariables": {"PATH": login_path}}))
    run(["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", agent])
    try:
        wait_socket()
        owned_pid = app_pid()
        check("candidate-launchagent-bare-tool", True)
    finally:
        run(["/bin/launchctl", "bootout", f"gui/{os.getuid()}/{label}"])
        owned_pid = None
    results["completed"] = True
    record({"name": "proof-complete", "remainingScope":
            "Gateway-to-node transport, actual login event, Developer-ID signed update and Keychain continuity not tested"})
finally:
    stop()
    run(["/bin/launchctl", "unsetenv", "PATH"])
