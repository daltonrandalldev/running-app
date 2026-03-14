#!/usr/bin/env python3
"""
sync_server.py
==============

Lightweight HTTP server that triggers the Garmin → Supabase pipeline
when called from the mobile app's sync button.

Normally you don't run this directly — setup_sync_server.py installs it
as a macOS LaunchAgent that starts automatically at login.

One-time setup:
    python3 setup_sync_server.py

The app calls POST http://localhost:5001/sync, which runs in sequence:
    1. garmin_download.py   (latest 25 activities from Garmin Connect)
    2. garmin_sync.py       (upsert new activities/laps to Supabase)
    3. pmc_backend.py       (recompute TSS/PMC against garmin_activities)

Physical device (Expo Go on phone)?
    Change SYNC_SERVER_URL in lib/syncApi.ts to your machine's LAN IP,
    e.g. 'http://192.168.1.42:5001'. Simulator uses localhost fine.

Logs (when running as a LaunchAgent):
    tail -f logs/sync_server.log
"""

import json
import socket
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
PORT = 5001

PIPELINE = [
    ("download", [sys.executable, str(SCRIPT_DIR / "garmin_download.py")]),
    ("sync",     [sys.executable, str(SCRIPT_DIR / "garmin_sync.py")]),
    ("pmc",      [sys.executable, str(SCRIPT_DIR / "pmc_backend.py")]),
]


def _port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("localhost", port)) == 0


class SyncHandler(BaseHTTPRequestHandler):

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._json({"ok": True})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path == "/sync":
            self._run_sync()
        elif self.path == "/sync/intervals":
            self._run_intervals_sync()
        elif self.path == "/sync/intervals/streams/backfill":
            self._run_intervals_streams_backfill()
        else:
            self._json({"error": "not found"}, 404)

    # ── internals ──────────────────────────────────────────────────────────────

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def _run_sync(self):
        results = {}
        for name, cmd in PIPELINE:
            print(f"[sync] {name}…", flush=True)
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                cwd=str(SCRIPT_DIR),
            )
            results[name] = {
                "exit_code": proc.returncode,
                "output": (proc.stdout or "")[-2000:],
            }
            if proc.returncode != 0:
                print(f"[sync] {name} FAILED (exit {proc.returncode})", flush=True)
                if proc.stderr:
                    print(proc.stderr[-500:], flush=True)
                self._json({"ok": False, "failed_step": name, "results": results}, 500)
                return
            print(f"[sync] {name} OK", flush=True)

        self._json({"ok": True, "results": results})

    def _run_intervals_sync(self):
        import json as _json
        content_length = int(self.headers.get("Content-Length", 0))
        body = {}
        if content_length > 0:
            raw = self.rfile.read(content_length)
            try:
                body = _json.loads(raw)
            except Exception:
                body = {}

        try:
            from sync.intervals_adapter import (
                fetch_activities, upsert_activities,
                fetch_wellness, upsert_wellness,
                _default_oldest, _today_iso,
            )
        except ValueError as e:
            self._json({"ok": False, "error": str(e)}, 400)
            return

        oldest = body.get("oldest", _default_oldest())
        newest = body.get("newest", _today_iso())

        try:
            activities = fetch_activities(oldest, newest)
            wellness   = fetch_wellness(oldest, newest)
            act_result  = upsert_activities(activities)
            well_result = upsert_wellness(wellness)
            self._json({
                "ok": True,
                "activities_upserted": act_result["count"],
                "wellness_upserted":   well_result["count"],
            })
        except ValueError as e:
            self._json({"ok": False, "error": str(e)}, 400)
        except Exception as e:
            self._json({"ok": False, "error": str(e)}, 500)

    def _run_intervals_streams_backfill(self):
        try:
            from sync.intervals_adapter import backfill_cycling_streams
            result = backfill_cycling_streams()
            self._json({
                "ok": True,
                "activities_found":      result["activities_found"],
                "activities_backfilled": result["activities_backfilled"],
                "rows_total":            result["rows_total"],
            })
        except ValueError as e:
            self._json({"ok": False, "error": str(e)}, 400)
        except Exception as e:
            self._json({"ok": False, "error": str(e)}, 500)

    def log_message(self, fmt, *args):
        print(f"[server] {fmt % args}", flush=True)


if __name__ == "__main__":
    # If another instance is already bound to the port (e.g. the LaunchAgent
    # restarted while a previous instance is still running), exit cleanly so
    # launchd doesn't loop. KeepAlive.SuccessfulExit=false means launchd only
    # restarts on non-zero exit, so exiting 0 here stops the restart cycle.
    if _port_in_use(PORT):
        print(f"Port {PORT} already in use — another instance is running. Exiting.", flush=True)
        sys.exit(0)

    server = HTTPServer(("localhost", PORT), SyncHandler)
    print(f"Sync server running at http://localhost:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
