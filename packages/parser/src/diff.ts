/**
 * Battle-state snapshot + diff — the shop-phase reconstruction.
 *
 * The game never logs a purchase directly, but every battle logs its complete
 * starting state. Diffing consecutive battle configs therefore reveals exactly
 * what happened in the shop/crossroads phase between them: who joined, what
 * got equipped, which relics arrived, rank-ups, rerolls, and how the shard
 * balance moved. Port of the diff logic in guildrun-tools/guildrun_replay.py,
 * returning log-native refs (Hero_13, tem_311, Relic_723) instead of display
 * names — callers resolve names via the catalog.
 */

import type { BattleConfig } from "./types.js";

export interface HeroSnapshot {
  ref: string;
  rank: number | null;
  items: string[];
  slots: number | null;
  classes: string[];
  rankmods: string[];
  reserve: boolean;
}

export interface BattleSnapshot {
  /** EntityId GUID -> hero state */
  heroes: Record<string, HeroSnapshot>;
  /** relic instance GUID -> entry ref */
  relics: Record<string, string>;
  shards: number | null;
  rerolls: number;
  seed: number | null;
  boss: boolean;
}

export interface SnapshotDiff {
  joined: HeroSnapshot[];
  left: HeroSnapshot[];
  ranked: { ref: string; from: number | null; to: number | null }[];
  equipped: { heroRef: string; itemRef: string }[];
  unequipped: { heroRef: string; itemRef: string }[];
  relics_gained: string[];
  relics_lost: string[];
  specialised: { ref: string; gained: string[] }[];
  /** prev.shards - cur.shards; positive = net spend across the phase
   * (net of the previous battle's rewards, which are not logged separately) */
  net_shards_spent: number | null;
  rerolls: number;
}

const stripSeq = (s: string | undefined): string => (s ?? "").replace("seq:", "");

export function snapshotBattle(cfg: BattleConfig | null): BattleSnapshot | null {
  if (!cfg) return null;
  const heroes: Record<string, HeroSnapshot> = {};
  const reserve = cfg.ReserveHeroDtos ?? [];
  for (const h of [...(cfg.HeroDtos ?? []), ...reserve]) {
    if (!h.EntityId) continue;
    heroes[h.EntityId] = {
      ref: stripSeq(h.CharacterRef),
      rank: h.Rank ?? null,
      items: (h.EquippedItems ?? [])
        .filter((i): i is NonNullable<typeof i> => i != null)
        .map((i) => stripSeq(i.ItemRef))
        .sort(),
      slots: h.EquippedItemLimit ?? null,
      classes: (h.HeroClasses ?? []).map((c) => stripSeq(c.Id)),
      rankmods: Object.values(h.AppliedRankModifiers ?? {}).map(stripSeq),
      reserve: reserve.includes(h),
    };
  }
  const relics: Record<string, string> = {};
  for (const r of cfg.ActiveRelics ?? []) {
    const guid = r.Id?.Guid;
    if (guid) relics[guid] = stripSeq(r.EntryRef);
  }
  const g = cfg.GlobalPermanentCustomData ?? {};
  return {
    heroes,
    relics,
    shards: cfg.CurrentPlayerShards ?? null,
    rerolls: Math.trunc(parseFloat(g["globalRerolls"] ?? "0") || 0),
    seed: cfg.Seed ?? null,
    boss: cfg.IsBossFloor ?? false,
  };
}

function countItems(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
}

export function diffSnapshots(prev: BattleSnapshot, cur: BattleSnapshot): SnapshotDiff {
  const out: SnapshotDiff = {
    joined: [], left: [], ranked: [], equipped: [], unequipped: [],
    relics_gained: [], relics_lost: [], specialised: [],
    net_shards_spent:
      prev.shards !== null && cur.shards !== null ? prev.shards - cur.shards : null,
    rerolls: cur.rerolls - prev.rerolls,
  };

  for (const [gid, h] of Object.entries(cur.heroes)) {
    const o = prev.heroes[gid];
    if (!o) {
      out.joined.push(h);
      continue;
    }
    if (h.rank !== o.rank) out.ranked.push({ ref: h.ref, from: o.rank, to: h.rank });
    const now = countItems(h.items);
    const before = countItems(o.items);
    for (const [item, n] of now) {
      const gained = n - (before.get(item) ?? 0);
      for (let k = 0; k < gained; k++) out.equipped.push({ heroRef: h.ref, itemRef: item });
    }
    for (const [item, n] of before) {
      const lost = n - (now.get(item) ?? 0);
      for (let k = 0; k < lost; k++) out.unequipped.push({ heroRef: h.ref, itemRef: item });
    }
    if (h.classes.length > o.classes.length) {
      const gained = h.classes.filter((c) => !o.classes.includes(c));
      if (gained.length) out.specialised.push({ ref: h.ref, gained });
    }
  }
  for (const [gid, h] of Object.entries(prev.heroes)) {
    if (!cur.heroes[gid]) out.left.push(h);
  }
  for (const [gid, ref] of Object.entries(cur.relics)) {
    if (!(gid in prev.relics)) out.relics_gained.push(ref);
  }
  for (const [gid, ref] of Object.entries(prev.relics)) {
    if (!(gid in cur.relics)) out.relics_lost.push(ref);
  }
  return out;
}
