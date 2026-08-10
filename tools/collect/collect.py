#!/usr/bin/env python3
"""
Guildrun Compendium collector — uploads your Guildrun logs to the compendium.

Stdlib only; no dependencies. Finds the game's log folder automatically
(Windows Steam libraries, macOS .app bundles, Linux/Proton paths), or point it
at a folder:

    python3 collect.py                       # autodetect
    python3 collect.py "C:/path/to/Guildrun_Data"
    python3 collect.py "~/Library/Application Support/Steam/steamapps/common/Guildrun Demo"
    python3 collect.py --server https://compendium.example.com

Note for macOS: the log we want is *not* Unity's ~/Library/Logs/Leyline/Guildrun/
Player.log — the game writes its own structured logs inside the app bundle at
Guildrun.app/Contents/Logs.

Privacy: your SteamID appears in a few log path lines; the server derives an
anonymous identity from it (salted HMAC) and scrubs it before storing anything.
"""

import argparse
import io
import json
import mimetypes
import os
import re
import sys
import urllib.request
import uuid
from pathlib import Path

DEFAULT_SERVER = "https://guildrun.gd0t.com"

CANDIDATE_ROOTS = [
    # Windows Steam default + common library layouts
    "C:/Program Files (x86)/Steam/steamapps/common",
    "C:/Program Files/Steam/steamapps/common",
    "D:/SteamLibrary/steamapps/common",
    "E:/SteamLibrary/steamapps/common",
    # macOS Steam + non-Steam .app installs
    "~/Library/Application Support/Steam/steamapps/common",
    "~/Applications",
    "/Applications",
    # Linux native + snap + flatpak
    "~/.steam/steam/steamapps/common",
    "~/.local/share/Steam/steamapps/common",
    "~/snap/steam/common/.local/share/Steam/steamapps/common",
    "~/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common",
]


def layouts(game_dir: Path):
    """(logs_dir, boot_config) candidates for a game folder.

    Windows/Linux: Guildrun_Data/{Logs,boot.config}.
    macOS: the .app bundle — Contents/Logs and Contents/Resources/Data/boot.config.
    """
    yield game_dir / "Guildrun_Data" / "Logs", game_dir / "Guildrun_Data" / "boot.config"
    bundles = [game_dir] if game_dir.suffix == ".app" else sorted(
        p for p in _children(game_dir) if p.suffix == ".app"
    )
    for app in bundles:
        yield app / "Contents" / "Logs", app / "Contents" / "Resources" / "Data" / "boot.config"


def _children(path: Path):
    try:
        return list(path.iterdir())
    except (PermissionError, FileNotFoundError, NotADirectoryError):
        return []


def resolve(game_dir: Path):
    """First layout of game_dir that actually has a Logs directory."""
    for logs, boot in layouts(game_dir):
        if logs.is_dir():
            return logs, boot
    return None


def find_installs():
    """Yield (logs_dir, boot_config) for each detected Guildrun install."""
    for root in CANDIDATE_ROOTS:
        base = Path(os.path.expanduser(root))
        if not base.is_dir():
            continue
        for game in _children(base):
            if not game.name.lower().startswith("guildrun"):
                continue
            found = resolve(game)
            if found:
                yield found


def gather_files(logs_dir: Path, boot: Path):
    files = sorted(logs_dir.glob("*.log"))
    if boot.is_file():
        files.append(boot)
    return files


def multipart(files):
    boundary = f"----guildrun-{uuid.uuid4().hex}"
    buf = io.BytesIO()
    for path in files:
        buf.write(f"--{boundary}\r\n".encode())
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        buf.write(
            f'Content-Disposition: form-data; name="files"; filename="{path.name}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n".encode()
        )
        buf.write(path.read_bytes())
        buf.write(b"\r\n")
    buf.write(f"--{boundary}--\r\n".encode())
    return boundary, buf.getvalue()


def upload(server: str, files):
    boundary, body = multipart(files)
    req = urllib.request.Request(
        server.rstrip("/") + "/api/upload",
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "X-Upload-Source": "collect-script",
            # Cloudflare blocks the default Python-urllib UA signature (error 1010)
            "User-Agent": "guildrun-collect/0.1 (+https://github.com/gdoteof/guildrun-compendium)",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.loads(res.read().decode())


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("path", nargs="?",
                    help="game folder, Guildrun_Data, .app bundle, or Logs dir "
                         "(autodetected if omitted)")
    ap.add_argument("--server", default=DEFAULT_SERVER)
    a = ap.parse_args()

    if a.path:
        given = Path(os.path.expanduser(a.path))
        if given.name == "Logs":
            # .../Guildrun_Data/Logs or .../Guildrun.app/Contents/Logs
            boot = given.parent / "boot.config"
            if not boot.is_file():
                boot = given.parent / "Resources" / "Data" / "boot.config"
            installs = [(given, boot)]
        else:
            found = resolve(given)
            if not found:
                sys.exit(f"No Logs directory under {given}")
            installs = [found]
    else:
        installs = list(find_installs())
        if not installs:
            sys.exit(
                "Could not find a Guildrun install. Pass the path explicitly:\n"
                "  python3 collect.py \"<...>/steamapps/common/Guildrun Demo\"\n"
                "macOS note: the logs are inside the bundle "
                "(Guildrun.app/Contents/Logs), not in ~/Library/Logs."
            )

    for logs_dir, boot in installs:
        files = gather_files(logs_dir, boot)
        logs = [f for f in files if f.suffix == ".log"]
        if not logs:
            print(f"{logs_dir}: no log files, skipping")
            continue
        total = sum(f.stat().st_size for f in files)
        print(f"{logs_dir}\n  uploading {len(logs)} log file(s) "
              f"({total // 1024} KB) to {a.server} ...")
        try:
            result = upload(a.server, files)
        except Exception as e:  # noqa: BLE001 - report and continue
            print(f"  upload failed: {e}")
            continue
        if result.get("duplicate"):
            print("  already uploaded — nothing new.")
        else:
            print(f"  runs found: {result.get('runs_found')}  "
                  f"new: {result.get('runs_inserted')}  "
                  f"extended: {result.get('runs_replaced')}  "
                  f"already known: {result.get('runs_skipped_duplicate')}")


if __name__ == "__main__":
    main()
