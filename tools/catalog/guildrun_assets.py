#!/usr/bin/env python3
"""
Extract Guildrun's content catalogue out of the shipped Unity assets.

Two sources, no game code needed:

1. Localisation (Addressables bundles under StreamingAssets/aa/StandaloneWindows64/)
     SharedTableData   keyId(uint64) -> key string, e.g. "Items.Item_311.Name"
     StringTable <loc> keyId(uint64) -> localised value, e.g. "Tank's Cape"
   Both are IL2CPP MonoBehaviours with no type tree, but each entry is laid out as
       <uint64 keyId><int32 byteLength><utf8><pad to 4>
   so pairs are recovered by scanning for length-prefixed strings and reading the
   8 bytes in front of them. Joining on keyId gives key -> text.

2. Sheet holders (Guildrun_Data/sharedassets1.assets)
   The game is driven by spreadsheet-exported ScriptableObjects named
   <Thing>SheetHolder. The *Pool* holders are plain enough to read positionally:
   each record is <int32 poolId><"<x>Pool" string>...<pool name>...<member ids>,
   which yields rarity buckets ("Common Items" / "Rare Items" / "Epic Items")
   and the stat-category pools.

3. Full sheet data (guildrun_sheets.py, needs TypeTreeGeneratorAPI)
   Typetrees regenerated from GameAssembly.dll + global-metadata.dat give
   byte-exact reads of every SheetHolder: item stat modifications, hero base
   stats, the localisation variables that fill {0} placeholders, and the
   sprite references used to export entity icons.

Writes catalog.json (and icon PNGs unless --no-icons). Icons are served from
R2 at runtime, not bundled with the site — after (re)extracting, sync them up:

  curl -X POST <server>/api/admin/icons -H "X-Admin-Token: $TOKEN" \
       $(for f in icons/*.png; do echo -F "files=@$f"; done)

Usage:  python3 guildrun_assets.py [GAMEDIR] [--locale english(en)]
                 [--no-sheets] [--no-icons] [--icons-out DIR]
"""

import json
import os
import re
import struct
import sys
from collections import defaultdict

import UnityPy


# ---------------------------------------------------------------- primitives

def unity_strings(buf, max_len=4000):
    """Yield (offset, text) for every length-prefixed, 4-byte-aligned string."""
    i, n = 0, len(buf)
    while i + 4 <= n:
        length = struct.unpack_from("<i", buf, i)[0]
        if 1 <= length <= max_len and i + 4 + length <= n:
            raw = buf[i + 4:i + 4 + length]
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                i += 4
                continue
            if text.strip() and (text.isprintable() or "\n" in text):
                yield i, text
                i += 4 + length + ((-length) & 3)
                continue
        i += 4


def keyed_strings(buf):
    """keyId -> text, for Unity Localization tables."""
    out = {}
    for off, text in unity_strings(buf):
        if off >= 8:
            kid = struct.unpack_from("<Q", buf, off - 8)[0]
            if kid:
                out.setdefault(kid, text)
    return out


def monobehaviours(path):
    env = UnityPy.load(path)
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            name = obj.read(check_read=False).m_Name
        except Exception:
            name = ""
        yield name, obj


# ---------------------------------------------------------------- extraction

def load_localisation(aa_dir, locale):
    suffix = "_" + locale.split("(")[1].rstrip(")")

    def tables(fname, want):
        found = {}
        full = os.path.join(aa_dir, fname)
        if not os.path.exists(full):
            raise SystemExit(f"missing bundle: {full}")
        for name, obj in monobehaviours(full):
            if name and name.endswith(want):
                found[name[: -len(want)].strip()] = keyed_strings(obj.get_raw_data())
        return found

    shared = tables("localization-assets-shared_assets_all.bundle", "Shared Data")
    values = tables(f"localization-string-tables-{locale}_assets_all.bundle", suffix)

    strings = {}
    for table, keys in shared.items():
        vals = values.get(table, {})
        for kid, key in keys.items():
            if kid in vals:
                strings[key] = vals[kid]
    return strings, sorted(shared)


def load_pools(assets_path, holder, marker, valid_ids):
    """Read a <Thing>PoolSheetHolder into {pool_name: [member ids]}."""
    tag = struct.pack("<i", len(marker)) + marker.encode() + b"\x00"
    for _, obj in monobehaviours(assets_path):
        buf = obj.get_raw_data()
        if holder.encode() not in buf[:200]:
            continue
        marks = [m.start() for m in re.finditer(re.escape(tag), buf)]
        pools = {}
        for k, off in enumerate(marks):
            end = marks[k + 1] - 4 if k + 1 < len(marks) else len(buf)
            rec = buf[off:end]
            # pool label = first genuinely texty string in the record; unnamed pools
            # otherwise pick up raw id bytes that happen to decode as printable
            name = next((t for _, t in unity_strings(rec[12:], 80)
                         if len(t) > 2 and re.fullmatch(r"[A-Za-z0-9 '&/:+-]{3,}", t)), None)
            ids, seen = [], set()
            for j in range(0, max(0, len(rec) - 4), 4):
                v = struct.unpack_from("<i", rec, j)[0]
                if v in valid_ids and v not in seen:
                    seen.add(v)
                    ids.append(v)
            if name and ids:
                pools.setdefault(name, [])
                pools[name] = sorted(set(pools[name]) | set(ids))
        return pools
    return {}


def main():
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    game = argv[0] if argv else "."
    locale = "english(en)"
    if "--locale" in sys.argv:
        locale = sys.argv[sys.argv.index("--locale") + 1]

    data = os.path.join(game, "Guildrun_Data")
    aa = os.path.join(data, "StreamingAssets", "aa", "StandaloneWindows64")
    shared_assets = os.path.join(data, "sharedassets1.assets")

    strings, tables = load_localisation(aa, locale)
    print(f"localisation: {len(strings)} strings across {len(tables)} tables", file=sys.stderr)

    # group "<Table>.<Thing_N>.<Field>" -> catalogue entries
    catalog = defaultdict(lambda: defaultdict(dict))
    for key, val in strings.items():
        m = re.match(r"^(\w+)\.(\w+)_(\d+)\.(\w+)$", key)
        if not m:
            continue
        table, kind, num, field = m.groups()
        catalog[table][int(num)][field] = val

    items = catalog["Items"]
    relics = catalog["Relics"]

    item_pools = load_pools(shared_assets, "ItemPoolSheetHolder", "temPool", set(items))
    relic_pools = load_pools(shared_assets, "RelicPoolSheetHolder", "RelicPool", set(relics))
    print(f"item pools: {len(item_pools)}   relic pools: {len(relic_pools)}", file=sys.stderr)

    def apply_pools(entries, pools, label):
        rarity_pool = {f"Common {label}": "Common", f"Rare {label}": "Rare",
                       f"Epic {label}": "Epic"}
        for pool, ids in pools.items():
            for i in ids:
                if i not in entries:
                    continue
                if pool in rarity_pool:
                    entries[i]["Rarity"] = rarity_pool[pool]
                else:
                    entries[i].setdefault("Pools", []).append(pool)

    apply_pools(items, item_pools, "Items")
    apply_pools(relics, relic_pools, "Relics")

    out = {
        "locale": locale,
        "items": {f"Item_{i}": v for i, v in sorted(items.items())},
        "relics": {f"Relic_{i}": v for i, v in sorted(relics.items())},
        "heroes": {f"Hero_{i}": v for i, v in sorted(catalog["Heroes"].items())},
        "enemies": {f"Enemy_{i}": v for i, v in sorted(catalog["Enemies"].items())},
        "hero_classes": {f"HeroClass_{i}": v for i, v in sorted(catalog["HeroClasses"].items())},
        "active_abilities": {f"ActiveAbility_{i}": v
                             for i, v in sorted(catalog["ActiveAbilities"].items())},
        "passive_abilities": {f"PassiveAbility_{i}": v
                              for i, v in sorted(catalog["PassiveAbilities"].items())},
        "hero_specializations": {f"HeroSpecialization_{i}": v
                                 for i, v in sorted(catalog["HeroSpecializations"].items())},
        "rank_modifiers": {f"RankModifier_{i}": v
                           for i, v in sorted(catalog["RankModifiers"].items())},
        "item_pools": item_pools,
        "relic_pools": relic_pools,
        "ui_strings": {k: v for k, v in strings.items() if k.startswith("UI.")},
    }
    if "--no-sheets" not in sys.argv:
        import guildrun_sheets
        names = {table: {num: fields["Name"] for num, fields in ents.items()
                         if "Name" in fields}
                 for table, ents in catalog.items()}
        reader = guildrun_sheets.SheetReader(game)
        icon_jobs = guildrun_sheets.enrich_catalog(out, reader, names)
        enriched = sum(1 for group in ("items", "relics", "heroes")
                       for v in out[group].values()
                       if "Stats" in v or "DescriptionValues" in v)
        print(f"sheets: enriched {enriched} entries; {len(icon_jobs)} icons referenced",
              file=sys.stderr)
        if "--no-icons" not in sys.argv:
            icons_out = "icons"
            if "--icons-out" in sys.argv:
                icons_out = sys.argv[sys.argv.index("--icons-out") + 1]
            written, failed = guildrun_sheets.export_icons(reader, icon_jobs, icons_out)
            print(f"icons: {written} written, {failed} failed -> {icons_out}/",
                  file=sys.stderr)

    with open("catalog.json", "w") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)

    for k in ("items", "relics", "heroes", "enemies", "hero_classes", "active_abilities",
              "passive_abilities", "hero_specializations", "rank_modifiers"):
        named = sum(1 for v in out[k].values() if "Name" in v)
        print(f"  {k:<22}{len(out[k]):>5} entries ({named} named)", file=sys.stderr)
    rar = defaultdict(int)
    for v in out["items"].values():
        rar[v.get("Rarity", "-")] += 1
    print(f"  item rarity split: {dict(rar)}", file=sys.stderr)
    rar = defaultdict(int)
    for v in out["relics"].values():
        rar[v.get("Rarity", "-")] += 1
    print(f"  relic rarity split: {dict(rar)}", file=sys.stderr)
    print("wrote catalog.json", file=sys.stderr)


if __name__ == "__main__":
    main()
