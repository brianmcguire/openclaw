"""Run only in the disposable hosted Mac job, never an operator desktop."""
import json
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import sys
import time
import urllib.request

assert sys.platform == "darwin"
assert os.environ.get("GITHUB_ACTIONS") == "true"
assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
assert os.environ.get("GITHUB_REPOSITORY") == "brianmcguire/openclaw"
candidate, output, driver = [Path(p).resolve() for p in sys.argv[1:]]
home_dir = Path.home()
state = home_dir / ".openclaw"
app = Path("/Applications/OpenClaw.app")
assert not state.exists() and not app.exists()
output.mkdir(exist_ok=True)
owned = []
streams = []
keychain = home_dir / "Library/Keychains/settings-proof.keychain-db"


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, text=True,
                          capture_output=True, timeout=60, **kwargs).stdout


def start(args, name, env):
    stream = (output / name).open("w")
    streams.append(stream)
    process = subprocess.Popen([str(a) for a in args], stdout=stream,
                               stderr=subprocess.STDOUT, env=env, start_new_session=True)
    owned.append(process)
    return process


try:
    keychain.parent.mkdir(parents=True, exist_ok=True)
    (home_dir / "Library/Preferences").mkdir(parents=True, exist_ok=True)
    for args in [["create-keychain", "-p", "", keychain],
                 ["unlock-keychain", "-p", "", keychain],
                 ["set-keychain-settings", keychain],
                 ["list-keychains", "-d", "user", "-s", keychain],
                 ["default-keychain", "-d", "user", "-s", keychain]]:
        run(["security"] + args)
    run(["ditto", candidate, app])
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    assert info["OpenClawGitCommit"] == "e9ee55430610d2ab4640fc8d4b37c6dcd4708e42", "Wrong candidate source"
    state.mkdir(mode=0o700)
    config = state / "openclaw.json"
    config.write_text(json.dumps({
        "gateway": {"mode": "local", "port": 18789, "bind": "loopback",
                    "auth": {"mode": "token", "token": "synthetic-settings-proof-151068"}},
        "agents": {"defaults": {"workspace": str(state / "workspace")}}
    }))
    config.chmod(0o600)
    domain = info["CFBundleIdentifier"]
    for key, kind, value in [
        ("openclaw.onboardingSeen", "bool", "true"),
        ("openclaw.onboardingVersion", "int", "8"),
        ("openclaw.swabbleEnabled", "bool", "false"),
        ("openclaw.computerControlEnabled", "bool", "false"),
        ("openclaw.cookieSyncEnabled", "bool", "false"),
        ("openclaw.nativeExperienceEnabled", "bool", "false"),
        ("SUEnableAutomaticChecks", "bool", "false")]:
        run(["defaults", "write", domain, key, "-" + kind, value])
    env = dict(os.environ)
    env.pop("OPENCLAW_PROFILE", None)
    env["OPENCLAW_STATE_DIR"] = str(state)
    env["OPENCLAW_CONFIG_PATH"] = str(config)
    runtime = app / "Contents/Resources/runtime"
    env["OPENCLAW_SQLITE_LIBRARY"] = str(runtime / "lib/libsqlite3.dylib")
    start([sys.executable, driver.parent / "deny_network_prompt.py", "--seconds", "420"],
          "local-network-denial.log", env)
    gateway = start([runtime / "bin/bun", runtime / "lib/node_modules/openclaw/openclaw.mjs",
                     "gateway", "run", "--allow-unconfigured"], "gateway.log", env)
    deadline = time.monotonic() + 100
    while True:
        assert gateway.poll() is None, "Owned Gateway exited; inspect gateway.log"
        try:
            with urllib.request.urlopen("http://127.0.0.1:18789/readyz", timeout=2) as response:
                assert response.status == 200
            break
        except OSError:
            if time.monotonic() > deadline:
                raise RuntimeError("Owned Gateway did not become healthy")
            time.sleep(0.5)
    native = start([app / "Contents/MacOS/OpenClaw", "--attach-only"], "native.log", env)
    (output / "build-identity.json").write_text(json.dumps({
        "sourceHead": "e9ee55430610d2ab4640fc8d4b37c6dcd4708e42",
        "bundleIdentifier": domain, "version": info.get("CFBundleShortVersionString"),
        "build": info.get("CFBundleVersion"), "pid": native.pid,
        "boundary": "GitHub-hosted disposable macOS, empty test Keychain, synthetic loopback Gateway",
        "packaging": "debug ad-hoc arm64, optional MLX TTS helper omitted"
    }, indent=2) + "\n")
    subprocess.run([sys.executable, str(driver), "--pid", str(native.pid),
                    "--expected-url", "http://127.0.0.1:18789/settings/appearance",
                    "--artifacts", str(output / "native-ui")], check=True, timeout=300, env=env)
finally:
    # This host has no user data; retain native/WebKit diagnostics before teardown.
    try:
        diagnostic = subprocess.run(['/usr/bin/log', 'show', '--last', '5m', '--style', 'compact',
                                     '--info', '--debug', '--predicate',
                                     'subsystem BEGINSWITH "ai.openclaw" OR (process == "OpenClaw" AND messageType == 16) OR (process CONTAINS "WebKit" AND messageType == 16)'],
                                    text=True, capture_output=True, timeout=20)
        (output / 'native-system.log').write_text(diagnostic.stdout + diagnostic.stderr)
    except (OSError, subprocess.TimeoutExpired) as error:
        (output / 'native-system.log').write_text(f'Diagnostic collection failed: {error}\n')
    for process in reversed(owned):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)
    for stream in streams:
        stream.close()
    # All resources live only in this disposable OS worker. Retain proof logs
    # until artifact upload; no user files or credentials were copied in.
    if keychain.exists():
        run(["security", "delete-keychain", keychain])
