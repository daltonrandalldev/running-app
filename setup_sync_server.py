#!/usr/bin/env python3
"""
setup_sync_server.py
====================

One-time setup: copies the sync pipeline to ~/.running-app/ (a location
macOS allows LaunchAgents to access) and installs a LaunchAgent so the
sync server starts automatically at every login.

Run once:
    python3 setup_sync_server.py

Re-run any time you update the pipeline scripts to push the changes.

To uninstall:
    python3 setup_sync_server.py --uninstall

Why the copy?
    macOS Sequoia's TCC sandbox prevents LaunchAgents from opening files
    in Desktop, Documents, or Downloads — even when the script path is
    absolute.  Copying the scripts to ~/.running-app/ sidesteps this
    entirely.  SUPABASE_DB_URL is read from .env here and embedded in the
    plist's EnvironmentVariables so the daemon never needs to touch .env
    at runtime.
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

LABEL      = "com.running-app.sync-server"
PLIST_PATH = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
DAEMON_DIR = Path.home() / ".running-app"
LOG_FILE   = DAEMON_DIR / "sync_server.log"

SCRIPT_DIR = Path(__file__).parent.resolve()

# Scripts to copy — order doesn't matter; sync_server.py calls the others
SCRIPTS_TO_COPY = [
    "sync_server.py",
    "garmin_download.py",
    "garmin_sync.py",
    "pmc_backend.py",
]


def _read_db_url() -> str:
    """Read SUPABASE_DB_URL from .env in the project directory."""
    env_path = SCRIPT_DIR / ".env"
    if not env_path.exists():
        sys.exit(f"  ✗ .env not found at {env_path}")
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line.startswith("SUPABASE_DB_URL="):
            return line.split("=", 1)[1].strip()
    sys.exit("  ✗ SUPABASE_DB_URL not found in .env")


def _plist(python_exe: str, server_path: str, db_url: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
    "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>{python_exe}</string>
        <string>{server_path}</string>
    </array>

    <!-- Pass DB credentials so the daemon never needs to read .env from Desktop -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>SUPABASE_DB_URL</key>
        <string>{db_url}</string>
    </dict>

    <!-- Start immediately when loaded, and after every login -->
    <key>RunAtLoad</key>
    <true/>

    <!-- Restart on crash; exit 0 (e.g. port-already-in-use guard) won't loop -->
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>StandardOutPath</key>
    <string>{LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>{LOG_FILE}</string>
</dict>
</plist>
"""


def install() -> None:
    db_url = _read_db_url()

    # ── Create daemon directory and copy scripts ───────────────────────────────
    DAEMON_DIR.mkdir(parents=True, exist_ok=True)
    for name in SCRIPTS_TO_COPY:
        src = SCRIPT_DIR / name
        if not src.exists():
            sys.exit(f"  ✗ {src} not found")
        shutil.copy2(src, DAEMON_DIR / name)
    print(f"  ✓ Scripts copied → {DAEMON_DIR}/")

    # ── Write plist ────────────────────────────────────────────────────────────
    server_path = str(DAEMON_DIR / "sync_server.py")
    PLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    PLIST_PATH.write_text(_plist(sys.executable, server_path, db_url))
    print(f"  ✓ Plist written  → {PLIST_PATH}")

    # ── Load (unload any old version first) ───────────────────────────────────
    subprocess.run(["launchctl", "unload", str(PLIST_PATH)], capture_output=True)
    result = subprocess.run(
        ["launchctl", "load", "-w", str(PLIST_PATH)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"  ✗ launchctl load failed:\n{result.stderr}")
        sys.exit(1)

    print("  ✓ Service started → running now")
    print(f"  ✓ Logs            → {LOG_FILE}")
    print()
    print("Sync server will start automatically at every login.")
    print("Tap the cloud icon in the app whenever you want to pull new activities.")
    print()
    print("Re-run this script any time you update sync_server.py or the pipeline scripts.")


def uninstall() -> None:
    if PLIST_PATH.exists():
        subprocess.run(["launchctl", "unload", str(PLIST_PATH)], capture_output=True)
        PLIST_PATH.unlink()
        print(f"  ✓ Removed {PLIST_PATH}")
    else:
        print("  LaunchAgent not installed.")
    if DAEMON_DIR.exists():
        shutil.rmtree(DAEMON_DIR)
        print(f"  ✓ Removed {DAEMON_DIR}")
    print("  Sync server will no longer start at login.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--uninstall", action="store_true",
                        help="Stop the service and remove the LaunchAgent")
    args = parser.parse_args()
    if args.uninstall:
        uninstall()
    else:
        install()
