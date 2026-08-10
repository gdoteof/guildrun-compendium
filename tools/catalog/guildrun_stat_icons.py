#!/usr/bin/env python3
"""
Export the game's own stat icons for the companion's Niklas' Belly overlay.

The game draws stat icons inline in its descriptions via TextMeshPro markup
(<maxhp>, <crit>, <attackspeed>, ...). Those glyphs are sprites sliced out of a
single atlas, `StatsIconAtlas`, in Guildrun_Data/resources.assets — so the
overlay can show the same icons the game does, rather than approximations.

Unlike the entity icons (which are served from the site), these have to be
EMBEDDED: the companion ships as one self-contained binary with no files on
disk. So this writes a CSS file of data: URIs, keyed by the TargetStat enum id
that the logs use.

Being extracted game art, that file is NOT committed (see .gitignore) — the
build scripts bake it in with `pnpm gen:ui --with-icons`, on a machine that has
run this. Plain `pnpm gen:ui` leaves it out, so the committed ui-embedded.ts
stays art-free.

Run per game version, from anywhere:

    python3 tools/catalog/guildrun_stat_icons.py [GAMEDIR] [--px 48] [--out PATH]

GAMEDIR defaults to the platform's Steam install; it accepts the game folder,
Guildrun_Data, or a macOS Guildrun.app bundle.
"""

import base64
import io
import os
import sys

import UnityPy
from PIL import Image

# TargetStat enum id -> sprite name in StatsIconAtlas. Ids mirror STAT_NAMES in
# guildrun_sheets.py (and packages/parser/src/belly.ts); the sprite names were
# matched against the atlas by eye, since nothing in the data links the two.
STAT_SPRITES = {
    1: ("Max HP", "HP"),
    4: ("Defense", "Defense"),
    6: ("Attack", "Attack"),
    7: ("Magic", "Magic"),
    9: ("Attack Speed", "AttackSpeed"),
    10: ("Attack Range", "AttackRange"),
    11: ("Crit", "Crit"),
    12: ("Mana Regen", "ManaRegen"),
    13: ("Omnivamp", "Omnivamp"),
    15: ("HP/S", "HPRegen"),
    18: ("Starting Mana", "Mana"),
}

# not a stat, but the belly reports shards generated
EXTRA_SPRITES = {"shard": ("Shards", "Shard")}

DEFAULT_OUT = "apps/companion/ui/stat-icons.css"


def find_data_dir(game_dir=None):
    """Resolve a game path to the Unity data directory, on any platform."""
    candidates = []
    if game_dir:
        candidates.append(game_dir)
    else:
        home = os.path.expanduser("~")
        candidates += [
            os.path.join(home, "Library/Application Support/Steam/steamapps/"
                               "common/Guildrun Demo"),
            os.path.join(home, ".steam/steam/steamapps/common/Guildrun Demo"),
            r"C:\Program Files (x86)\Steam\steamapps\common\Guildrun Demo",
        ]
    for base in candidates:
        for rel in ("Guildrun_Data",                       # Windows / Linux
                    "Guildrun.app/Contents/Resources/Data",  # macOS bundle
                    "Contents/Resources/Data",               # given the .app itself
                    ""):                                     # given the data dir
            path = os.path.join(base, rel) if rel else base
            if os.path.exists(os.path.join(path, "resources.assets")):
                return path
    return None


def load_sprites(data_dir, wanted):
    """name -> PIL image, for the wanted sprite names in StatsIconAtlas."""
    env = UnityPy.load(os.path.join(data_dir, "resources.assets"))
    found = {}
    for obj in env.objects:
        if obj.type.name != "Sprite":
            continue
        sprite = obj.read()
        if sprite.m_Name not in wanted or sprite.m_Name in found:
            continue
        try:
            atlas = sprite.m_RD.texture.read().m_Name
        except Exception:
            atlas = None
        if atlas != "StatsIconAtlas":
            continue
        found[sprite.m_Name] = sprite.image
    return found


def as_data_uri(image, px):
    """Trim to the drawn pixels, fit in a px box, and encode as a PNG data URI."""
    image = image.convert("RGBA")
    bbox = image.getbbox()
    if bbox:
        image = image.crop(bbox)
    image.thumbnail((px, px), Image.LANCZOS)
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    px = int(sys.argv[sys.argv.index("--px") + 1]) if "--px" in sys.argv else 48
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else DEFAULT_OUT

    data_dir = find_data_dir(args[0] if args else None)
    if not data_dir:
        sys.exit("Could not find the game's data dir. Pass it: "
                 "guildrun_stat_icons.py \"<...>/Guildrun Demo\"")

    jobs = {**{f"stat-{sid}": v for sid, v in STAT_SPRITES.items()}, **EXTRA_SPRITES}
    sprites = load_sprites(data_dir, {sprite for _, sprite in jobs.values()})

    lines = [
        "/* GENERATED from the game's StatsIconAtlas by",
        " * tools/catalog/guildrun_stat_icons.py - do not edit by hand.",
        " *",
        " * The game's own stat glyphs, embedded as data URIs because the companion",
        " * ships as a single self-contained binary. Classes are keyed by the",
        " * TargetStat enum id the logs use, so no name matching happens at runtime.",
        " */",
        ".icon {",
        "  display: inline-block; width: 1.05em; height: 1.05em;",
        "  vertical-align: -0.15em; margin-right: .12em;",
        "  background-size: contain; background-repeat: no-repeat;",
        "  background-position: center;",
        "}",
    ]
    missing = []
    for cls, (label, sprite) in sorted(jobs.items()):
        image = sprites.get(sprite)
        if image is None:
            missing.append(f"{cls} ({sprite})")
            continue
        lines.append(f"/* {label} */")
        lines.append(f".icon-{cls} {{ background-image: url({as_data_uri(image, px)}); }}")

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "w") as fh:
        fh.write("\n".join(lines) + "\n")

    size_kb = os.path.getsize(out) / 1024
    print(f"stat icons: {len(jobs) - len(missing)}/{len(jobs)} at {px}px "
          f"-> {out} ({size_kb:.0f}KB)")
    if missing:
        print("  missing (atlas changed?): " + ", ".join(missing), file=sys.stderr)


if __name__ == "__main__":
    main()
