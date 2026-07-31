#!/usr/bin/env python3
"""
Parse Guildrun's balancing SheetHolder ScriptableObjects with full type
information, despite the IL2CPP build stripping every typetree.

How: TypeTreeGeneratorAPI regenerates typetrees from GameAssembly.dll +
global-metadata.dat. Three of its quirks need correcting before UnityPy can
read the data byte-exact (all 25 holders verified with check_read=True):

  1. It emits a ManagedReferencesRegistry copy after every SerializeReference
     field; Unity serializes exactly one, at the very end of the object.
  2. It gives plain [Serializable] SerializeReference targets a MonoBehaviour
     header (m_GameObject/m_Enabled/m_Script/m_Name) they don't have on disk.
  3. It types array-of-primitive fields as the element type (string[] ->
     "string"), which UnityPy's primitive fast-path reads as a single value.

SerializeReference payloads (the ModularEffect graphs and the localisation
variables that fill {0} placeholders) are resolved by monkeypatching
UnityPy's get_ref_type_node to generate each referenced class's tree on
demand from the class/ns/asm names embedded in the registry stream.
"""

import io
import os
import sys
from contextlib import redirect_stdout

import UnityPy
from UnityPy.helpers import TypeTreeHelper
from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator
from UnityPy.helpers.TypeTreeNode import TypeTreeNode

PRIMITIVES = {
    "string", "int", "float", "bool", "UInt8", "SInt64", "UInt64", "SInt16",
    "UInt16", "SInt8", "char", "double", "UInt32", "SInt32",
}

# TargetStat / StatType enum, anchored by StatMod sheet titles, item stat
# pools and quest reward descriptions (18 = Arcane Conduit "Starting Mana").
STAT_NAMES = {
    1: "Max HP",
    4: "Defense",
    6: "Attack",
    7: "Magic",
    9: "Attack Speed",
    10: "Attack Range",
    11: "Crit",
    12: "Mana Regen",
    13: "Omnivamp",
    15: "HP/S",
    18: "Starting Mana",
}

FP = 65536.0  # Q48.16 fixed point used for all fractional balancing values


def fp(v):
    """FP {RawValue} -> float (int when whole)."""
    x = v["RawValue"] / FP if isinstance(v, dict) else v / FP
    return int(x) if float(x).is_integer() else round(x, 3)


class SheetReader:
    def __init__(self, game_dir):
        self.game_dir = game_dir
        # the generator prints C# exceptions for unresolvable engine types;
        # swallow that noise
        with redirect_stdout(io.StringIO()):
            self.gen = TypeTreeGenerator(self._unity_version())
            self.gen.load_local_game(game_dir)
        self.env = UnityPy.load(
            os.path.join(game_dir, "Guildrun_Data", "sharedassets1.assets"))
        self.by_pid = {o.path_id: o for o in self.env.objects}
        self._ref_cache = {}
        TypeTreeHelper.get_ref_type_node = self._ref_type_node
        TypeTreeHelper.read_typetree_boost = None  # boost can't do our ref patch

    def _unity_version(self):
        env = UnityPy.load(
            os.path.join(self.game_dir, "Guildrun_Data", "sharedassets1.assets"))
        return next(iter(env.files.values())).unity_version

    # -------------------------------------------------------------- typetrees

    def _nodes(self, assembly, full_class):
        with redirect_stdout(io.StringIO()):
            return self.gen.get_nodes(assembly.replace(".dll", ""), full_class)

    @staticmethod
    def _build_tree(flat_src):
        """Generator nodes -> UnityPy tree, fixing quirk 3 (see module doc)."""
        flat = [TypeTreeNode(n.m_Level, n.m_Type, n.m_Name, 0, 0,
                             m_MetaFlag=n.m_MetaFlag) for n in flat_src]
        for i, n in enumerate(flat):
            if n.m_Type not in PRIMITIVES:
                continue
            if i + 3 < len(flat) and flat[i + 1].m_Level == n.m_Level + 1 \
                    and flat[i + 1].m_Type == "Array":
                if n.m_Type == "string" and flat[i + 3].m_Type == "char":
                    continue  # a genuine string
                flat[i] = TypeTreeNode(n.m_Level, "vector", n.m_Name, 0, 0,
                                       m_MetaFlag=n.m_MetaFlag)
        return TypeTreeNode.from_list(flat)

    def _root_tree(self, assembly, full_class):
        """Holder tree with quirk 1 fixed: one registry, at the end."""
        flat = list(self._nodes(assembly, full_class))
        keep, registry, i = [], None, 0
        while i < len(flat):
            n = flat[i]
            if n.m_Level == 1 and n.m_Type == "ManagedReferencesRegistry":
                j = i + 1
                while j < len(flat) and flat[j].m_Level > 1:
                    j += 1
                registry = flat[i:j]
                i = j
            else:
                keep.append(n)
                i += 1
        if registry:
            keep.extend(registry)
        return self._build_tree(keep)

    def _ref_type_node(self, ref_object, assetfile):
        """get_ref_type_node replacement; fixes quirk 2 for ref targets."""
        typ = ref_object["type"]
        cls, ns, asm = typ["class"], typ["ns"], typ["asm"]
        if cls == "":
            return None
        key = (asm, ns, cls)
        if key not in self._ref_cache:
            flat = list(self._nodes(asm, f"{ns}.{cls}" if ns else cls))
            header = {"m_GameObject", "m_Enabled", "m_Script", "m_Name"}
            keep, i = [flat[0]], 1
            while i < len(flat):
                n = flat[i]
                if n.m_Level == 1 and (n.m_Name in header
                                       or n.m_Type == "ManagedReferencesRegistry"):
                    i += 1
                    while i < len(flat) and flat[i].m_Level > 1:
                        i += 1
                else:
                    keep.append(n)
                    i += 1
            self._ref_cache[key] = self._build_tree(keep)
        return self._ref_cache[key]

    # ------------------------------------------------------------------ reads

    def read_monobehaviour(self, obj):
        """Read any MonoBehaviour byte-exact via its MonoScript."""
        mbr = obj.read(check_read=False)
        ms = mbr.m_Script.read()
        full = (ms.m_Namespace + "." if ms.m_Namespace else "") + ms.m_ClassName
        root = self._root_tree(ms.m_AssemblyName, full)
        return obj.read_typetree(nodes=root, check_read=True), mbr.m_Name

    def holders(self):
        """Yield (holder_name, parsed_tree) for every *SheetHolder."""
        for obj in self.env.objects:
            if obj.type.name != "MonoBehaviour":
                continue
            try:
                name = obj.read(check_read=False).m_Name
            except Exception:
                continue
            if not name or "SheetHolder" not in name:
                continue
            try:
                tree, _ = self.read_monobehaviour(obj)
            except Exception as e:
                print(f"  {name}: PARSE FAILED {e!r}", file=sys.stderr)
                continue
            yield name, tree


# ------------------------------------------------------------------- helpers

def entries(tree):
    return tree.get("<Entries>k__BackingField", [])


def registry(tree):
    return {r["rid"]: r for r in tree.get("references", {}).get("RefIds", [])
            if "data" in r}


def seq_id(entry):
    return entry["<Id>k__BackingField"]["_sequentialId"]


def loca_values(entry, field, regs):
    """{placeholder-name: value} for a LocaKey field's smart-string variables."""
    lk = entry.get(f"<{field}>k__BackingField")
    if not lk:
        return {}
    out = {}
    for pair in lk.get("_localizedString", {}).get("m_LocalVariables", []):
        ref = regs.get(pair.get("variable", {}).get("rid"))
        if not ref:
            continue
        data = ref.get("data", {})
        val = data.get("m_Value")
        if val is None and len(data) == 1:
            val = next(iter(data.values()))
        if isinstance(val, dict) and "RawValue" in val:
            val = fp(val)
        if val is not None:
            out[pair["name"]] = str(val)
    return out


def stat_mods(entry):
    """ItemStatModification list -> [{stat, value}] with named stats."""
    out = []
    for m in entry.get("<StatModifications>k__BackingField", []):
        sid = m["<TargetStat>k__BackingField"]
        out.append({"stat": STAT_NAMES.get(sid, f"Stat{sid}"),
                    "value": m["<Value>k__BackingField"]})
    return out


LOCA_FIELDS = (
    ("DescriptionLocaKey", "DescriptionValues"),
    ("QuestDescriptionLocaKey", "QuestDescriptionValues"),
    ("QuestRewardDescriptionLocaKey", "QuestRewardDescriptionValues"),
    ("DataTrackingDescriptionLocaKey", "DataTrackingDescriptionValues"),
)


def _apply_loca_values(dst, entry, regs):
    for field, out_key in LOCA_FIELDS:
        vals = loca_values(entry, field, regs)
        if vals:
            dst[out_key] = vals


GENDERS = {0: "female", 1: "male", 2: "neutral"}

HERO_STAT_FIELDS = [
    # (sheet field, output key, is_fixed_point)
    ("MaxHealth", "Max HP", False),
    ("MaxMana", "Max Mana", False),
    ("StartingMana", "Starting Mana", False),
    ("ManaRegen", "Mana Regen", False),
    ("Defense", "Defense", False),
    ("BaseAttackDamage", "Base Attack Damage", False),
    ("Attack", "Attack", False),
    ("Magic", "Magic", False),
    ("AttackRange", "Attack Range", False),
    ("BaseAttackSpeed", "Base Attack Speed", True),
    ("AttackSpeed", "Attack Speed", False),
    ("Crit", "Crit", False),
    ("MoveSpeed", "Move Speed", True),
]


def _char_stats(entry):
    stats = {}
    for field, key, fixed in HERO_STAT_FIELDS:
        v = entry.get(f"<{field}>k__BackingField")
        if v is None:
            continue
        stats[key] = fp(v) if fixed else v
    return stats


def enrich_catalog(out, reader, names):
    """Add sheet-derived stats, resolved {0} placeholder values and icon refs
    to the localisation-derived catalogue. `names` maps a localisation table
    name to {sequential id: display name} (for class/guild/ability lookups).
    """
    sheets = dict(reader.holders())
    icon_jobs = {}  # ref -> (path_id, max_px)

    def sheet(name):
        return sheets.get(name, {})

    # ---- items
    regs = registry(sheet("ItemSheetHolder"))
    for e in entries(sheet("ItemSheetHolder")):
        ref = f"Item_{seq_id(e)}"
        dst = out["items"].get(ref)
        if dst is None:
            continue
        mods = stat_mods(e)
        if mods:
            dst["Stats"] = mods
        _apply_loca_values(dst, e, regs)
        pid = e["<Icon>k__BackingField"]["m_PathID"]
        if pid:
            icon_jobs[ref] = (pid, 128)

    # ---- relics
    regs = registry(sheet("RelicSheetHolder"))
    for e in entries(sheet("RelicSheetHolder")):
        ref = f"Relic_{seq_id(e)}"
        dst = out["relics"].get(ref)
        if dst is None:
            continue
        _apply_loca_values(dst, e, regs)
        pid = e["<Icon>k__BackingField"]["m_PathID"]
        if pid:
            icon_jobs[ref] = (pid, 128)

    # ---- heroes
    class_names = names.get("HeroClasses", {})
    guild_names = {seq_id(e): e.get("_title", "")
                   for e in entries(sheet("GuildSheetHolder"))}
    for e in entries(sheet("HeroSheetHolder")):
        ref = f"Hero_{seq_id(e)}"
        dst = out["heroes"].get(ref)
        if dst is None:
            continue
        dst["Stats"] = _char_stats(e)
        pr = e.get("<PriceRange>k__BackingField")
        if pr:
            dst["Price"] = [pr["x"], pr["y"]]
        classes = [class_names.get(c) or f"HeroClass_{c}"
                   for c in (e.get("_class1ID"), e.get("_class2ID"))
                   if c and c > 0]
        if classes:
            dst["Classes"] = classes
        g = e.get("_guildID")
        if g and g > 0:
            dst["Guild"] = guild_names.get(g, f"Guild_{g}")
        for fld, key, prefix in (("_passiveAbilityID", "PassiveAbility", "PassiveAbility"),
                                 ("_activeAbilityID", "ActiveAbility", "ActiveAbility")):
            a = e.get(fld)
            if a and a > 0:
                dst[key] = f"{prefix}_{a}"
        tags = e.get("_tags")
        if tags:
            dst["Tags"] = tags
        dst["Gender"] = GENDERS.get(e.get("<Gender>k__BackingField"), "neutral")
        # portraits live on the CharacterVisualConfig
        vc_pid = e["<VisualConfig>k__BackingField"]["m_PathID"]
        vc_obj = reader.by_pid.get(vc_pid)
        if vc_obj is not None:
            try:
                vc, _ = reader.read_monobehaviour(vc_obj)
                sq = vc.get("<SquarePortraitSprite>k__BackingField", {}).get("m_PathID")
                rd = vc.get("<SmallPortraitSprite>k__BackingField", {}).get("m_PathID")
                if sq:
                    icon_jobs[ref] = (sq, 256)
                if rd:
                    icon_jobs[f"{ref}_round"] = (rd, 128)
            except Exception as exc:
                print(f"  {ref}: visual config unreadable ({exc!r})", file=sys.stderr)

    # ---- enemies
    for e in entries(sheet("EnemySheetHolder")):
        ref = f"Enemy_{seq_id(e)}"
        dst = out["enemies"].get(ref)
        if dst is None:
            continue
        dst["Stats"] = _char_stats(e)

    # ---- abilities & rank modifiers (resolved values + icons)
    for holder, table, prefix in (
            ("ActiveAbilitySheetHolder", "active_abilities", "ActiveAbility"),
            ("PassiveAbilitySheetHolder", "passive_abilities", "PassiveAbility"),
            ("RankModifierSheetHolder", "rank_modifiers", "RankModifier")):
        regs = registry(sheet(holder))
        for e in entries(sheet(holder)):
            ref = f"{prefix}_{seq_id(e)}"
            dst = out[table].get(ref)
            if dst is None:
                continue
            _apply_loca_values(dst, e, regs)
            tags = e.get("_tags")
            if tags:
                dst["Tags"] = tags
            icon = e.get("<Icon>k__BackingField", {}).get("m_PathID")
            if icon:
                icon_jobs[ref] = (icon, 128)

    # ---- hero classes: primary/secondary stat names
    for e in entries(sheet("HeroClassSheetHolder")):
        ref = f"HeroClass_{seq_id(e)}"
        dst = out["hero_classes"].get(ref)
        if dst is None:
            continue
        p = e.get("<PrimaryStat>k__BackingField")
        if p:
            dst["PrimaryStat"] = STAT_NAMES.get(p, f"Stat{p}")
        sec = e.get("<SecondaryStats>k__BackingField")
        if sec:
            dst["SecondaryStats"] = [STAT_NAMES.get(s, f"Stat{s}") for s in sec]

    out["stat_names"] = STAT_NAMES
    return icon_jobs


def export_icons(reader, icon_jobs, out_dir):
    """Write each icon job as <out_dir>/<ref>.png, downscaling to max_px."""
    os.makedirs(out_dir, exist_ok=True)
    written = failed = 0
    for ref, (pid, max_px) in sorted(icon_jobs.items()):
        obj = reader.by_pid.get(pid)
        if obj is None or obj.type.name not in ("Sprite", "Texture2D"):
            failed += 1
            continue
        try:
            img = obj.read().image
            if img.width > max_px or img.height > max_px:
                img.thumbnail((max_px, max_px))
            img.save(os.path.join(out_dir, f"{ref}.png"))
            written += 1
        except Exception as exc:
            print(f"  icon {ref}: {exc!r}", file=sys.stderr)
            failed += 1
    return written, failed
