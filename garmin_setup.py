#!/usr/bin/env python3
"""
garmin_setup.py
===============

Generates ~/.GarminDb/GarminConnectConfig.json from environment variables.
Run this once before any Garmin sync to ensure credentials are in place.

Required .env variables
-----------------------
    GARMIN_USER      — your Garmin Connect email address
    GARMIN_PASSWORD  — your Garmin Connect password

Usage
-----
    python3 garmin_setup.py

After this succeeds, trigger the first download with:
    python3 garmin_download.py
"""

import json
import os
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:
    sys.exit("Missing dependency — run: pip install python-dotenv")

# ── Load .env ────────────────────────────────────────────────────────────────

script_dir = Path(__file__).parent
load_dotenv(script_dir / ".env")

garmin_user = os.getenv("GARMIN_USER")
garmin_password = os.getenv("GARMIN_PASSWORD")

if not garmin_user or garmin_user == "your_garmin_email@example.com":
    sys.exit(
        "GARMIN_USER not set.\n"
        "Edit .env and replace 'your_garmin_email@example.com' with your Garmin Connect email."
    )

if not garmin_password or garmin_password == "your_garmin_password":
    sys.exit(
        "GARMIN_PASSWORD not set.\n"
        "Edit .env and replace 'your_garmin_password' with your Garmin Connect password."
    )

# ── Build config ─────────────────────────────────────────────────────────────

config = {
    "db": {
        "type": "sqlite"
    },
    "garmin": {
        "domain": "garmin.com"
    },
    "credentials": {
        "user": garmin_user,
        "secure_password": False,
        "password": garmin_password
    },
    "data": {
        "weight_start_date": "01/01/2020",
        "sleep_start_date": "01/01/2020",
        "rhr_start_date": "01/01/2020",
        "monitoring_start_date": "01/01/2020",
        "download_latest_activities": 25,
        "download_all_activities": 1000
    },
    "directories": {
        "relative_to_home": True,
        "base_dir": "HealthData",
        "mount_dir": "/Volumes/GARMIN"
    },
    "enabled_stats": {
        "monitoring": True,
        "steps": True,
        "itime": True,
        "sleep": True,
        "rhr": True,
        "weight": True,
        "activities": True
    },
    "course_views": {
        "steps": []
    },
    "modes": {},
    "activities": {
        "display": []
    },
    "settings": {
        "metric": True,
        "default_display_activities": ["walking", "running", "cycling"]
    },
    "checkup": {
        "look_back_days": 90
    }
}

# ── Write config ─────────────────────────────────────────────────────────────

config_dir = Path.home() / ".GarminDb"
config_dir.mkdir(exist_ok=True)
config_path = config_dir / "GarminConnectConfig.json"

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(config, f, indent=4)

print(f"✓ Config written to {config_path}")
print(f"  User: {garmin_user}")
print(f"  Data directory: ~/HealthData")
print()
print("Next step — download data from Garmin Connect:")
print("    python3 garmin_download.py")
