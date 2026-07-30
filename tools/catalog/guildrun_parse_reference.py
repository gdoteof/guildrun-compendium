#!/usr/bin/env python3
"""
Guildrun log parser.

Reads Guildrun_Data/Logs/*.log and reconstructs:
  - sessions (app launches)
  - runs (seed, difficulty, floors, outcome)
  - battles (stage, sim seed, full roster/relic snapshot, deaths, outcome, duration)
  - shop offers/odds, crossroads choices, events, relic grants
  - cross-referenced content registries (Hero_N -> name, Relic_N -> name, ...)

Usage:
    python3 guildrun_parse.py [LOGDIR] [--json OUTDIR]
"""

import json
import re
import sys
import os
from collections import defaultdict, Counter
from datetime import datetime

LINE_RE = re.compile(
    r"^\[(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\] "
    r"\[(?P<level>[A-Z]+)\] "
    r"\[(?P<src>[^\]]+)\] "
    r"(?:\[(?P<method>[A-Za-z_0-9]+):(?P<srcline>\d+)\] )?"
    r"(?P<msg>.*)$"
)

STAGE_RE = re.compile(r"^Stage_(\d+)$")
GUID_RE = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

TS_FMT = "%Y-%m-%d %H:%M:%S.%f"

# Established two independent ways:
#  (a) Relic_1000..1006 are the "<Class>'s Medallion" series, in this order;
#  (b) correlating per-battle deltas of <class>PlayCount in GlobalPermanentCustomData
#      against how many heroes on the previous board held each HeroClass_N.
CLASS_NAMES = {
    "HeroClass_1": "Warrior", "HeroClass_2": "Tank", "HeroClass_3": "Vanguard",
    "HeroClass_4": "Assassin", "HeroClass_5": "Duelist", "HeroClass_6": "Mystic",
    "HeroClass_7": "Mage",
}


def parse_stage(stage_id):
    """Stage IDs decode as <difficulty><floor:2><variant:2>, with three special forms:

        Stage_10000        fixed opening encounter (floor 0)
        Stage_101/102/103  endless maps, entered only after clearing floor 13
        Stage_5xxxx        optional event-fight encounter, not a campaign floor
        Stage_30102        difficulty 3, floor 1, variant 2
        Stage_301002       difficulty 3, floor 10, variant 2
    """
    m = STAGE_RE.match(stage_id)
    if not m:
        return None
    d = m.group(1)
    base = {"raw": stage_id, "difficulty": None, "floor": None, "variant": None, "kind": "unknown"}
    if d == "10000":
        return {**base, "floor": 0, "variant": 0, "kind": "opening"}
    if len(d) == 3:
        return {**base, "kind": "endless", "endless_map": int(d[2])}
    if len(d) == 5:
        di, fl, va = int(d[0]), int(d[1:3]), int(d[3:5])
    elif len(d) == 6:
        di, fl, va = int(d[0]), int(d[1:4]), int(d[4:6])
    else:
        return base
    if di == 5:          # event-fight pool, floor digits are pool indices not campaign floors
        return {**base, "variant": va, "kind": "event_fight", "pool": fl}
    return {"raw": stage_id, "difficulty": di, "floor": fl, "variant": va, "kind": "campaign"}


class Parser:
    def __init__(self):
        self.records = []
        self.sessions = []
        self.runs = []
        # registries
        self.hero_guid_name = {}          # entity guid -> hero display name
        self.relic_guid_name = {}         # relic instance guid -> relic display name
        self.hero_ref_names = defaultdict(Counter)   # "Hero_13" -> Counter(names)
        self.relic_ref_names = defaultdict(Counter)  # "Relic_723" -> Counter(names)
        self.hero_ref_classes = defaultdict(Counter)
        self.hero_ref_abilities = defaultdict(Counter)
        self.class_hero_names = defaultdict(Counter)
        self.item_refs = Counter()
        self.shop_odds = []               # (floor, kind, {tier: pct})
        self.enemy_names = Counter()
        self.hero_names = set()
        self.crossroads = Counter()
        self.events = Counter()
        self.errors = Counter()

    # ---------- pass 1: tokenise ----------
    def read(self, paths):
        for p in paths:
            with open(p, "r", encoding="utf-8", errors="replace") as fh:
                for i, raw in enumerate(fh, 1):
                    raw = raw.rstrip("\n")
                    m = LINE_RE.match(raw)
                    if not m:
                        continue          # continuation line of a multi-line message
                    d = m.groupdict()
                    d["file"] = os.path.basename(p)
                    d["lineno"] = i
                    d["msg"] = d["msg"].rstrip()
                    self.records.append(d)
        self.records.sort(key=lambda r: r["ts"])

    # ---------- pass 2: reconstruct ----------
    def build(self):
        session = None
        run = None
        battle = None
        shop = None
        pending_stage = None
        pending_kind = None

        def close_battle(outcome=None, ts=None):
            nonlocal battle
            if battle is None:
                return
            if outcome:
                battle["outcome"] = outcome
            def secs(a, b):
                try:
                    return round((datetime.strptime(b, TS_FMT) -
                                  datetime.strptime(a, TS_FMT)).total_seconds(), 1)
                except (ValueError, TypeError):
                    return None
            # board init -> simulation start is the player's placement/planning phase;
            # simulation start -> end condition is the auto-battle itself.
            if ts and battle.get("sim_start_ts"):
                battle["combat_s"] = secs(battle["sim_start_ts"], ts)
                battle["planning_s"] = secs(battle["start_ts"], battle["sim_start_ts"])
            elif ts:
                battle["combat_s"] = None
                battle["planning_s"] = None
            if run is not None:
                run["battles"].append(battle)
            battle = None

        def close_run(ts=None, reason=None):
            nonlocal run
            if run is None:
                return
            close_battle(ts=ts)
            run["end_ts"] = ts
            run["end_reason"] = reason
            outcomes = [b.get("outcome") for b in run["battles"]]
            run["battles_won"] = outcomes.count("victory")
            run["battles_lost"] = outcomes.count("defeat")
            run["floors_reached"] = max(
                [b["stage"]["floor"] for b in run["battles"]
                 if b.get("stage") and b["stage"].get("floor") is not None] or [0])
            # A run counts as beaten once floor 13 is cleared. Clearing it drops the
            # player into endless mode, so reaching an endless stage also implies it.
            run["beaten"] = any(
                (b["stage"]["kind"] == "endless") or
                (b["stage"]["kind"] == "campaign" and b["stage"]["floor"] == 13
                 and b.get("outcome") == "victory")
                for b in run["battles"] if b.get("stage"))
            run["endless_battles"] = sum(
                1 for b in run["battles"] if b.get("stage", {}).get("kind") == "endless")
            run["event_fights"] = sum(
                1 for b in run["battles"] if b.get("stage", {}).get("kind") == "event_fight")
            self.runs.append(run)
            run = None

        for r in self.records:
            ts, src, meth, msg = r["ts"], r["src"], r["method"], r["msg"]

            # ---- session boundaries ----
            if src == "ApplicationScope.cs" and meth == "InitializeApplication":
                close_run(ts, "app restart")
                session = {"start_ts": ts, "log_file": r["file"], "runs": 0}
                self.sessions.append(session)
                continue

            if src == "ProgressionService.cs" and meth == "TryLoadProgressionData":
                m = re.search(r"(\d+) total started runs and (\d+) runs beaten\. "
                              r"Highest difficulty beaten is (\d+)\. "
                              r"Total completed tutorial steps is (\d+)", msg)
                if m and session:
                    session["progression_at_launch"] = {
                        "total_started_runs": int(m.group(1)),
                        "runs_beaten": int(m.group(2)),
                        "highest_difficulty_beaten": int(m.group(3)),
                        "tutorial_steps_done": int(m.group(4)),
                    }
                continue

            # ---- run boundaries ----
            if src == "ProgressionService.cs" and meth == "OnRunStarted":
                close_run(ts, "new run started")
                run = {"start_ts": ts, "log_file": r["file"], "seed": None,
                       "difficulty": None, "battles": [], "shops": [],
                       "crossroads": [], "events": [], "relics_granted": [],
                       "heroes_created": [], "rank_ups": [], "lives_lost": 0,
                       "endless_maps": None, "act_boss_relics": []}
                if session:
                    session["runs"] += 1
                continue

            if src == "RunSessionService.cs" and meth == "Init":
                m = re.search(r"Run session initialized with seed (-?\d+)\. Endless maps: (\d+)", msg)
                if m and run is not None:
                    run["seed"] = int(m.group(1))
                    run["endless_maps"] = int(m.group(2))
                m = re.search(r"Using existing seed for run session: (-?\d+)", msg)
                if m and run is not None:
                    run["seed"] = int(m.group(1))
                    run["resumed"] = True
                continue

            if src == "DifficultyService.cs" and meth == "OnActStarted":
                m = re.search(r"stage: (Stage_\d+), relic: (Relic_\d+)", msg)
                if m and run is not None:
                    st = parse_stage(m.group(1))
                    run["act_boss_relics"].append({"stage": st, "relic_ref": m.group(2)})
                    if st and st.get("difficulty"):
                        run["difficulty"] = st["difficulty"]
                continue

            # ---- battles ----
            if src == "BoardService.cs" and meth == "InitializeBoard":
                # NB: enemy placement is logged from InitializeBoard too, so match it
                # before the "new board" branch swallows the line.
                mm = re.search(r"Placed enemy (%s) at \((\d+), (\d+)\)" % GUID_RE, msg)
                if mm:
                    if battle is not None:
                        battle["enemy_positions"].append([int(mm.group(2)), int(mm.group(3))])
                    continue
                m = re.search(r"Initializing board for stage (Stage_\d+)", msg)
                if m:
                    close_battle(ts=ts)
                    pending_stage = parse_stage(m.group(1))
                    battle = {"stage": pending_stage, "start_ts": ts, "sim_seed": None,
                              "deaths": [], "outcome": None, "enemy_positions": [],
                              "hero_positions": [], "swaps": 0, "config": None,
                              "battle_kind": pending_kind}
                    pending_kind = None
                    if run is not None and run.get("difficulty") is None and pending_stage:
                        run["difficulty"] = pending_stage.get("difficulty")
                continue

            if battle is not None and src == "BoardService.cs":
                if meth == "InitializeBoard":
                    pass
                mm = re.search(r"Placed enemy (%s) at \((\d+), (\d+)\)" % GUID_RE, msg)
                if mm:
                    battle["enemy_positions"].append([int(mm.group(2)), int(mm.group(3))])
                    continue
                mm = re.search(r"Added new hero (%s) to position \((\d+), (\d+)\)" % GUID_RE, msg)
                if mm:
                    battle["hero_positions"].append(
                        {"guid": mm.group(1), "pos": [int(mm.group(2)), int(mm.group(3))]})
                    continue
                if meth == "SwapBoardPositions":
                    battle["swaps"] += 1
                    continue

            if src == "RunSessionService.cs" and meth == "StartNextBattle":
                # logged just *before* the board for that battle is initialised
                pending_kind = msg.replace("Starting ", "").replace(" battle", "").strip()
                continue

            if src == "BattleSimulationService.cs" and meth == "StartSimulation":
                m = re.search(r"Starting simulation with seed (-?\d+)", msg)
                if m and battle is not None:
                    battle["sim_seed"] = int(m.group(1))
                    battle["sim_start_ts"] = ts
                continue

            if src == "BattleSimulationService.cs" and meth == "LogBattle":
                m = re.search(r"Starting battle with config: (\{.*\})", msg)
                if m:
                    try:
                        cfg = json.loads(m.group(1))
                    except json.JSONDecodeError:
                        continue
                    if battle is not None:
                        battle["config"] = cfg
                    self._index_config(cfg)
                continue

            if src == "EntityDeathSystem.cs" and meth == "Tick":
                name = msg.replace(" has died", "").strip()
                if battle is not None:
                    battle["deaths"].append({"name": name, "ts": ts})
                if name:
                    if name in self.hero_names:
                        pass
                    self.enemy_names[name] += 1
                continue

            if src == "EndConditionSystem.cs" and meth == "Tick":
                if "All enemies are dead" in msg or "Forced end of combat: Victory" in msg:
                    close_battle("victory", ts)
                elif "All players are dead" in msg or "Forced end of combat: Defeat" in msg:
                    close_battle("defeat", ts)
                continue

            # ---- shop ----
            if src == "ShopService.cs":
                if meth == "BuildShop":
                    shop = {"ts": ts, "odds": {}, "sales": [],
                            "after_floor": (run["battles"][-1]["stage"]["floor"]
                                            if run and run["battles"] and run["battles"][-1].get("stage")
                                            else None)}
                    if run is not None:
                        run["shops"].append(shop)
                    continue
                if meth == "DebugPrintChances":
                    m = re.match(r"Randomized (\w+) choices with chances:(.*)", msg)
                    if m and shop is not None:
                        kind = m.group(1)
                        tiers = dict(
                            (k.strip(), float(v))
                            for k, v in re.findall(r"\[([^:\]]+): (-?[\d.]+)\]", m.group(2)))
                        shop["odds"][kind] = tiers
                        self.shop_odds.append((shop.get("after_floor"), kind, tiers))
                    continue
                m = re.search(r"Shop sale applied to (hero|item|relic) (.+?) at index (\d+)", msg)
                if m and shop is not None:
                    shop["sales"].append({"kind": m.group(1), "name": m.group(2),
                                          "index": int(m.group(3))})
                    continue
                m = re.search(r"Modified item cost delta by (-?\d+)\. New delta: (-?\d+)", msg)
                if m and run is not None:
                    run.setdefault("item_cost_deltas", []).append(int(m.group(2)))
                continue

            if src == "ShopServiceAnalyticsBuilder.cs" and meth == "HandleShopClosed":
                m = re.search(r"Heroes purchased: (\d+) \(Not purchased: (\d+), Sold: (\d+)\), "
                              r"Items purchased: (\d+) \(Not purchased: (\d+), Sold: (\d+)\), "
                              r"Relics purchased: (\d+) \(Not purchased: (\d+)\)", msg)
                if m and shop is not None:
                    g = [int(x) for x in m.groups()]
                    shop["closed"] = {
                        "heroes_bought": g[0], "heroes_offered_unbought": g[1], "heroes_sold": g[2],
                        "items_bought": g[3], "items_offered_unbought": g[4], "items_sold": g[5],
                        "relics_bought": g[6], "relics_offered_unbought": g[7],
                    }
                    shop = None
                continue

            # ---- economy / roster ----
            if src == "PlayerService.cs":
                m = re.search(r"Granting relic (.+?) \((%s)\)" % GUID_RE, msg)
                if m:
                    self.relic_guid_name[m.group(2)] = m.group(1)
                    if run is not None:
                        run["relics_granted"].append({"name": m.group(1), "guid": m.group(2), "ts": ts})
                    continue
                if meth == "DecrementLife":
                    if run is not None:
                        run["lives_lost"] += 1
                        if "no active stabilizer" in msg:
                            run["died_without_stabilizer"] = True
                    continue
                m = re.search(r"Gaining (\d+) shard interest", msg)
                if m and run is not None:
                    run.setdefault("shard_interest", []).append(int(m.group(1)))
                    continue
                continue

            if src == "GameRegistryService.cs":
                m = re.search(r"Added new hero (.+?) \((%s)\)" % GUID_RE, msg)
                if m:
                    self.hero_guid_name[m.group(2)] = m.group(1)
                    self.hero_names.add(m.group(1))
                    if run is not None:
                        run["heroes_created"].append({"name": m.group(1), "guid": m.group(2), "ts": ts})
                    continue
                m = re.search(r"Ranked up hero (.+?) to rank ([A-Z])", msg)
                if m and run is not None:
                    run["rank_ups"].append({"name": m.group(1), "to_rank": m.group(2), "ts": ts})
                    continue
                continue

            if src == "Entity.cs" and meth == "AddHeroClass":
                m = re.search(r"Adding class (HeroClass_\d+) to hero (.+)", msg)
                if m:
                    self.class_hero_names[m.group(1)][m.group(2).strip()] += 1
                continue

            # ---- narrative ----
            if src == "CrossroadsService.cs" and meth == "SetupSelectedCrossroadsPath":
                m = re.search(r"Selected crossroads path: (.*?) \(index (\d+)\)", msg, re.S)
                if m:
                    txt = m.group(1).strip()
                    self.crossroads[txt] += 1
                    if run is not None:
                        run["crossroads"].append({"text": txt, "index": int(m.group(2)), "ts": ts})
                continue

            if src == "EventService.cs" and meth == "SetActiveEvent":
                m = re.search(r"Set active event to: (.+)", msg)
                if m:
                    self.events[m.group(1).strip()] += 1
                    if run is not None:
                        run["events"].append({"name": m.group(1).strip(), "ts": ts})
                continue

            if r["level"] == "ERROR":
                self.errors[f"{src}:{meth}"] += 1

        close_run(self.records[-1]["ts"] if self.records else None, "end of logs")

    def _index_config(self, cfg):
        """Cross-reference the battle-config JSON against name registries."""
        for h in cfg.get("HeroDtos", []) + cfg.get("ReserveHeroDtos", []):
            ref = (h.get("CharacterRef") or "").replace("seq:", "")
            name = self.hero_guid_name.get(h.get("EntityId"))
            if ref and name:
                self.hero_ref_names[ref][name] += 1
            for c in h.get("HeroClasses", []):
                cid = (c.get("Id") or "").replace("seq:", "")
                if ref and cid:
                    self.hero_ref_classes[ref][cid] += 1
                if name and cid:
                    self.class_hero_names[cid][name] += 1
            aid = ((h.get("ActiveAbility") or {}).get("Id") or "").replace("seq:", "")
            if ref and aid and not aid.startswith("guid:"):
                self.hero_ref_abilities[ref][aid] += 1
            for it in h.get("EquippedItems") or []:
                if it:
                    self.item_refs[(it.get("ItemRef") or "").replace("seq:", "")] += 1
        for rel in cfg.get("ActiveRelics", []):
            ref = (rel.get("EntryRef") or "").replace("seq:", "")
            guid = ((rel.get("Id") or {}).get("Guid"))
            name = self.relic_guid_name.get(guid)
            if ref and name:
                self.relic_ref_names[ref][name] += 1


def top_name(counter):
    return counter.most_common(1)[0][0] if counter else None


def main():
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    logdir = argv[0] if argv else "Guildrun_Data/Logs"
    outdir = None
    if "--json" in sys.argv:
        outdir = sys.argv[sys.argv.index("--json") + 1]

    paths = sorted(os.path.join(logdir, f) for f in os.listdir(logdir) if f.endswith(".log"))
    p = Parser()
    p.read(paths)
    p.build()

    # ---------------- report ----------------
    W = 78
    def hdr(t):
        print("\n" + "=" * W + f"\n{t}\n" + "=" * W)

    print(f"Parsed {len(p.records):,} log records from {len(paths)} files "
          f"({p.records[0]['ts'][:10]} .. {p.records[-1]['ts'][:10]})")

    hdr("SESSIONS & RUNS")
    print(f"app launches : {len(p.sessions)}")
    print(f"runs         : {len(p.runs)}")
    print(f"battles      : {sum(len(r['battles']) for r in p.runs)}")
    won = sum(r["battles_won"] for r in p.runs)
    lost = sum(r["battles_lost"] for r in p.runs)
    print(f"battle W/L   : {won} / {lost}  ({won/(won+lost)*100:.1f}% win rate)")
    diffs = Counter(r["difficulty"] for r in p.runs if r["difficulty"])
    print(f"difficulties : {dict(sorted(diffs.items()))}")
    fl = Counter(r["floors_reached"] for r in p.runs)
    print(f"floor reached: {dict(sorted(fl.items()))}")
    print(f"runs beaten  : {sum(1 for r in p.runs if r['beaten'])}")

    hdr("RUN LOG")
    print(f"{'start':<13}{'seed':>11} {'dif':>3} {'flr':>4} {'W':>3} {'L':>3} "
          f"{'evt':>4} {'endl':>5} {'hero':>5} {'relic':>6} {'shop':>5}  result")
    for r in p.runs:
        if not r["battles"]:
            continue
        print(f"{r['start_ts'][5:16]:<13}{str(r['seed']):>11} "
              f"{str(r['difficulty'] or '-'):>3} {r['floors_reached']:>4} "
              f"{r['battles_won']:>3} {r['battles_lost']:>3} "
              f"{r['event_fights']:>4} {r['endless_battles']:>5} "
              f"{len(r['heroes_created']):>5} {len(r['relics_granted']):>6} "
              f"{len(r['shops']):>5}  {'BEATEN' if r['beaten'] else 'died f%d' % r['floors_reached']}")

    hdr("CAMPAIGN STRUCTURE  (per floor, campaign battles only)")
    per = defaultdict(lambda: {"n": 0, "w": 0, "variants": set(), "boss": 0,
                               "enemies": 0, "heroes": [], "dur": [], "plan": []})
    for r in p.runs:
        for b in r["battles"]:
            st = b.get("stage") or {}
            if st.get("kind") != "campaign":
                continue
            e = per[st["floor"]]
            e["n"] += 1
            e["w"] += b.get("outcome") == "victory"
            e["variants"].add(st["variant"])
            e["enemies"] += len(b["enemy_positions"])
            cfg = b.get("config") or {}
            e["boss"] += bool(cfg.get("IsBossFloor"))
            e["heroes"].append(len(cfg.get("HeroDtos", [])))
            if b.get("combat_s"):
                e["dur"].append(b["combat_s"])
            if b.get("planning_s"):
                e["plan"].append(b["planning_s"])
    mean = lambda xs: sum(xs) / len(xs) if xs else 0
    print(f"  {'floor':>5}{'battles':>9}{'win%':>7}{'variants':>10}{'boss':>6}"
          f"{'avg enemies':>13}{'avg party':>11}{'plan s':>9}{'combat s':>10}")
    for f in sorted(per):
        e = per[f]
        print(f"  {f:>5}{e['n']:>9}{e['w']/e['n']*100:>6.0f}%{len(e['variants']):>10}"
              f"{'yes' if e['boss'] else '-':>6}{e['enemies']/e['n']:>13.1f}"
              f"{mean(e['heroes']):>11.1f}{mean(e['plan']):>9.0f}{mean(e['dur']):>10.0f}")
    missing = [f for f in range(1, 14) if f not in per]
    print(f"  floors with no combat stage at all: {missing}  "
          f"(non-combat / crossroads floors)")

    hdr("CONTENT REGISTRY  (resolved by cross-referencing GUIDs -> seq: refs)")
    print(f"-- heroes ({len(p.hero_ref_names)} resolved of {len(p.hero_names)} names seen) --")
    rows = sorted(p.hero_ref_names.items(), key=lambda kv: int(kv[0].split("_")[1]))
    for ref, names in rows:
        cls = "/".join(CLASS_NAMES.get(c, c) for c in
                       sorted(p.hero_ref_classes[ref], key=lambda c: int(c.split("_")[1])))
        ab = ",".join(sorted(p.hero_ref_abilities[ref], key=lambda c: int(c.split("_")[1])))
        print(f"  {ref:<10} {top_name(names):<10} {cls:<26} {ab}")

    unresolved = sorted(p.hero_names - {top_name(v) for v in p.hero_ref_names.values()})
    if unresolved:
        print(f"  (never appeared in a logged battle config: {', '.join(unresolved)})")

    print(f"\n-- relics ({len(p.relic_ref_names)} resolved) --")
    for ref, names in sorted(p.relic_ref_names.items(), key=lambda kv: int(kv[0].split("_")[1])):
        print(f"  {ref:<14} {top_name(names)}")

    print(f"\n-- hero classes (roster membership) --")
    for cid, names in sorted(p.class_hero_names.items(), key=lambda kv: int(kv[0].split("_")[1])):
        print(f"  {cid:<13} {CLASS_NAMES.get(cid, '?'):<9} "
              f"{', '.join(n for n, _ in names.most_common(12))}")

    hdr("HERO USAGE  (fielded = appeared on a battle board)")
    fielded, wins, deaths = Counter(), Counter(), Counter()
    for r in p.runs:
        for b in r["battles"]:
            cfg = b.get("config") or {}
            names = set()
            for h in cfg.get("HeroDtos", []):
                ref = (h.get("CharacterRef") or "").replace("seq:", "")
                n = top_name(p.hero_ref_names.get(ref, Counter()))
                if n:
                    names.add(n)
            for n in names:
                fielded[n] += 1
                if b.get("outcome") == "victory":
                    wins[n] += 1
            for d in b["deaths"]:
                if d["name"] in p.hero_names:
                    deaths[d["name"]] += 1
    print(f"  {'hero':<11}{'classes':<24}{'battles':>8}{'win%':>7}{'deaths':>8}{'death/battle':>14}")
    for n, c in fielded.most_common():
        ref = next((k for k, v in p.hero_ref_names.items() if top_name(v) == n), None)
        cls = "/".join(CLASS_NAMES.get(x, x) for x in
                       sorted(p.hero_ref_classes.get(ref, {}), key=lambda x: int(x.split("_")[1])))
        print(f"  {n:<11}{cls:<24}{c:>8}{wins[n]/c*100:>6.0f}%{deaths[n]:>8}"
              f"{deaths[n]/c:>14.2f}")

    print(f"\n-- items: {len(p.item_refs)} distinct ItemRefs seen (no name mapping in logs) --")
    print("   " + ", ".join(k for k, _ in sorted(p.item_refs.items())[:24]) + " ...")

    hdr("SHOP RARITY ODDS BY FLOOR  (mean %, from DebugPrintChances)")
    agg = defaultdict(lambda: defaultdict(list))
    for floor, kind, tiers in p.shop_odds:
        if floor is None:
            continue
        for tier, pct in tiers.items():
            agg[(kind, floor)][tier].append(pct)
    for kind in ("Hero", "Item", "Relic"):
        floors = sorted(f for (k, f) in agg if k == kind)
        if not floors:
            continue
        tiers = sorted({t for f in floors for t in agg[(kind, f)]},
                       key=lambda t: list(agg[(kind, floors[0])]).index(t)
                       if t in agg[(kind, floors[0])] else 99)
        print(f"\n{kind}:")
        print("  floor " + "".join(f"{t:>12}" for t in tiers))
        for f in floors:
            cells = ""
            for t in tiers:
                v = agg[(kind, f)].get(t)
                cells += f"{(sum(v)/len(v)):>12.1f}" if v else f"{'-':>12}"
            print(f"  {f:>5} " + cells)

    hdr("ENEMIES / DEATHS")
    hero_set = p.hero_names
    enemies = [(n, c) for n, c in p.enemy_names.most_common() if n and n not in hero_set]
    heroes_died = [(n, c) for n, c in p.enemy_names.most_common() if n in hero_set]
    print(f"distinct enemy types killed: {len(enemies)}")
    for n, c in enemies[:40]:
        print(f"  {c:>5}  {n}")
    print(f"\nhero deaths (top): " + ", ".join(f"{n}({c})" for n, c in heroes_died[:12]))

    hdr("CROSSROADS PATHS CHOSEN")
    for txt, c in p.crossroads.most_common(25):
        t = txt.replace("\n", " ")[:96] or "(blank)"
        print(f"  {c:>3}  {t}")

    hdr("EVENTS ENCOUNTERED")
    for name, c in p.events.most_common(30):
        print(f"  {c:>3}  {name}")

    hdr("ERROR HOTSPOTS")
    for k, c in p.errors.most_common(12):
        print(f"  {c:>5}  {k}")

    if outdir:
        os.makedirs(outdir, exist_ok=True)
        with open(os.path.join(outdir, "runs.json"), "w") as fh:
            json.dump(p.runs, fh, indent=1)
        with open(os.path.join(outdir, "registry.json"), "w") as fh:
            json.dump({
                "heroes": {k: {"name": top_name(v),
                               "classes": sorted(p.hero_ref_classes[k]),
                               "abilities": sorted(p.hero_ref_abilities[k])}
                           for k, v in p.hero_ref_names.items()},
                "relics": {k: top_name(v) for k, v in p.relic_ref_names.items()},
                "classes": {k: sorted(v) for k, v in p.class_hero_names.items()},
                "items": sorted(p.item_refs),
                "enemies": dict(p.enemy_names),
                "events": dict(p.events),
                "crossroads": dict(p.crossroads),
            }, fh, indent=1)
        print(f"\nwrote {outdir}/runs.json and {outdir}/registry.json")


if __name__ == "__main__":
    main()
