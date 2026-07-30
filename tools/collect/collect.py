#!/usr/bin/env python3
"""
Guildrun Compendium collector — uploads your Guildrun logs to the compendium.

Stdlib only; no dependencies. Finds the game's log folder automatically
(Windows Steam libraries and Linux/Proton paths), or point it at a folder:

    python3 collect.py                       # autodetect
    python3 collect.py "C:/path/to/Guildrun_Data"
    python3 collect.py --server https://compendium.example.com

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

DEFAULT_SERVER = "https://guildrun-compendium.laxity-03-hunger3397.workers.dev"

CANDIDATE_ROOTS = [
    # Windows Steam default + common library layouts
    "C:/Program Files (x86)/Steam/steamapps/common",
    "C:/Program Files/Steam/steamapps/common",
    "D:/SteamLibrary/steamapps/common",
    "E:/SteamLibrary/steamapps/common",
    # Linux native + snap + flatpak
    "~/.steam/steam/steamapps/common",
    "~/.local/share/Steam/steamapps/common",
    "~/snap/steam/common/.local/share/Steam/steamapps/common",
    "~/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common",
]


def find_data_dirs():
    """Yield existing Guildrun*/Guildrun_Data directories."""
    for root in CANDIDATE_ROOTS:
        base = Path(os.path.expanduser(root))
        if not base.is_dir():
            continue
        try:
            for game in base.iterdir():
                if game.is_dir() and game.name.lower().startswith("guildrun"):
                    data = game / "Guildrun_Data"
                    if (data / "Logs").is_dir():
                        yield data
        except PermissionError:
            continue


def gather_files(data_dir: Path):
    files = sorted((data_dir / "Logs").glob("*.log"))
    boot = data_dir / "boot.config"
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
    ap.add_argument("path", nargs="?", help="Guildrun_Data directory (autodetected if omitted)")
    ap.add_argument("--server", default=DEFAULT_SERVER)
    a = ap.parse_args()

    if a.path:
        data_dirs = [Path(a.path)]
        # accept the Logs dir or the game root too
        if data_dirs[0].name == "Logs":
            data_dirs = [data_dirs[0].parent]
        elif (data_dirs[0] / "Guildrun_Data").is_dir():
            data_dirs = [data_dirs[0] / "Guildrun_Data"]
    else:
        data_dirs = list(find_data_dirs())
        if not data_dirs:
            sys.exit(
                "Could not find a Guildrun install. Pass the path explicitly:\n"
                "  python3 collect.py \"<...>/steamapps/common/Guildrun Demo/Guildrun_Data\""
            )

    for data_dir in data_dirs:
        files = gather_files(data_dir)
        logs = [f for f in files if f.suffix == ".log"]
        if not logs:
            print(f"{data_dir}: no log files, skipping")
            continue
        total = sum(f.stat().st_size for f in files)
        print(f"{data_dir}\n  uploading {len(logs)} log file(s) "
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
