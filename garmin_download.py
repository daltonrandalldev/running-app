#!/usr/bin/env python3
"""
garmin_download.py
==================

Downloads activity FIT files from Garmin Connect into ~/HealthData
and imports them into the local GarminDB SQLite databases.

Run garmin_setup.py first to generate ~/.GarminDb/GarminConnectConfig.json.

Usage
-----
    python3 garmin_download.py            # download latest 25 activities
    python3 garmin_download.py --all      # download all activities (up to 1000)

After this completes, run:
    python3 garmin_sync.py
"""

import argparse
import logging
import os
import re
import sys

# ── Dependency checks ────────────────────────────────────────────────────────
try:
    from garmindb.download import Download
    from garmindb.garmin_connect_config_manager import GarminConnectConfigManager
    from garmindb.fit_data import FitData
    from garmindb.activity_fit_file_processor import ActivityFitFileProcessor
    from garmindb.plugin_manager import PluginManager
    from garmindb.garmindb import GarminDb, ActivitiesDb, Activities
    import fitfile
except ImportError:
    sys.exit("Missing dependency — run: pip install garmindb")

# ── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# ── Suppress noisy urllib3 SSL warning ───────────────────────────────────────
import warnings
import urllib3
warnings.filterwarnings("ignore", category=urllib3.exceptions.NotOpenSSLWarning)


def main():
    parser = argparse.ArgumentParser(description="Download activities from Garmin Connect")
    parser.add_argument("--all", action="store_true", help="Download all activities instead of latest 25")
    args = parser.parse_args()

    # ── Load config ───────────────────────────────────────────────────────────
    try:
        gc_config = GarminConnectConfigManager()
    except SystemExit:
        sys.exit(
            "Config not found. Run first:\n"
            "    python3 garmin_setup.py"
        )

    db_params = gc_config.get_db_params()
    activities_dir = gc_config.get_activities_dir()
    measurement_system = fitfile.field_enums.DisplayMeasure.metric

    logger.info("GarminDB data directory: %s", gc_config.get_base_dir())
    logger.info("Activities FIT files:     %s", activities_dir)

    # ── Step 1: Authenticate + download FIT files ─────────────────────────────
    logger.info("Authenticating with Garmin Connect…")
    dl = Download()
    if not dl.login():
        sys.exit("Login failed. Check your credentials in .env and re-run garmin_setup.py.")

    if args.all:
        count = gc_config.all_activity_count()
        logger.info("Downloading all activities (up to %d)…", count)
    else:
        count = gc_config.latest_activity_count()
        logger.info("Downloading latest %d activities…", count)

    dl.get_activities(activities_dir, count, overwite=False)
    logger.info("✓ FIT files downloaded to %s", activities_dir)

    # ── Step 2: Import FIT files into local SQLite ────────────────────────────
    logger.info("Importing FIT files into local GarminDB SQLite…")

    plugins_dir = gc_config.get_plugins_dir()
    plugin_manager = PluginManager(plugins_dir, db_params)

    fit_data = FitData(
        activities_dir,
        debug=0,
        latest=False,  # we do our own filtering below
        recursive=False,
        fit_types=None,
        measurement_system=measurement_system,
    )

    if not args.all:
        # Query local SQLite for activity IDs already imported, then skip those FIT files.
        # FIT filenames are formatted as "{activity_id}_ACTIVITY.fit".
        act_db = ActivitiesDb(db_params)
        with act_db.managed_session() as session:
            known_ids = {str(r.activity_id) for r in session.query(Activities.activity_id).all()}
        def _is_new(path):
            m = re.search(r'/(\d+)_ACTIVITY\.fit$', path, re.IGNORECASE)
            return m is None or m.group(1) not in known_ids

        fit_data.file_names = [f for f in fit_data.file_names if _is_new(f)]

    if fit_data.file_count() == 0:
        logger.info("No new FIT files to import.")
    else:
        processor = ActivityFitFileProcessor(db_params, plugin_manager=plugin_manager, debug=0)
        fit_data.process_files(processor)
        logger.info("✓ Imported %d FIT files into SQLite", fit_data.file_count())

    logger.info("")
    logger.info("Download + import complete. Run the sync next:")
    logger.info("    python3 garmin_sync.py")


if __name__ == "__main__":
    main()
