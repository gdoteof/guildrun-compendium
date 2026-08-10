/**
 * Niklas' Belly — reconstructing what Niklas ate, from the logs alone.
 *
 * Niklas' passive (Red Hot Deals) reads:
 *
 *   "When Niklas survives combat, consume the item in his left-most item slot.
 *    Permanently gain {0}% of its stats and gain Shards equal to {1}% its value."
 *
 * The game never logs the consumption itself, but every battle logs Niklas'
 * complete state, and three fields move when he eats:
 *
 *   PermanentCustomData.niklasItemsConsumedCount  — the meal counter
 *   PermanentCustomData.customDataTracking2       — cumulative shards generated
 *                                                   (the passive's own tracker)
 *   StatModifications                             — append-only; the permanent
 *                                                   stats granted show up as
 *                                                   new {Type, Value} entries
 *
 * So a consumption between battle N and N+1 is: the counter went up by k, and
 * the item eaten is the left-most non-empty slot of battle N (the shop can
 * rearrange his bags afterwards, so it must be read from the battle he
 * survived, not the one where the gain appears).
 *
 * Attribution of the stat gain: the caller supplies item stats from the catalog
 * (this package has no catalog access), and we use those to work out WHICH of
 * the logged StatModifications entries belong to the item — but the amounts
 * always come from the log, because an item can grant more than it prints (see
 * claimForItem). Anything in the delta the eaten items don't explain comes from
 * some other source that battle (rank modifiers, relics, events) and is
 * reported separately rather than credited to the belly.
 */

import type { Battle, BattleConfig, HeroDto } from "./types.js";

/** Niklas. Referenced by his log-native ref so the caller needs no catalog. */
export const NIKLAS_REF = "Hero_9";

const CONSUMED_KEY = "niklasItemsConsumedCount";
const SHARDS_KEY = "customDataTracking2"; // {1} of the passive's DataTrackingDescription

/**
 * TargetStat enum -> display name. Mirrors STAT_NAMES in
 * tools/catalog/guildrun_sheets.py, which anchors it against the StatMod sheet
 * titles; unmapped ids render as "Stat <n>" rather than being dropped.
 */
export const STAT_NAMES: Record<number, string> = {
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
};

export function statName(stat: number): string {
  return STAT_NAMES[stat] ?? `Stat ${stat}`;
}

export interface BellyStat {
  stat: number;
  name: string;
  /** what he actually gained, as logged */
  value: number;
  /** the catalog's printed value, present only when the game granted something
   *  else — an item whose own effect had pumped its stats (Deadeye Hood's
   *  triple, Assassin's Hood's accumulated Crit) grants the pumped amount */
  base?: number;
}

/** How the stats credited to a bite were arrived at. */
export type BellyAttribution =
  /** the item is known, and the catalog told us which logged entries are its
   *  (the amounts still come from the log — see `BellyStat.base`) */
  | "catalog"
  /** no catalog stats for the item — the logged delta is credited as-is */
  | "logged"
  /** neither the item nor a stat delta could be identified */
  | "unknown";

export interface BellyBite {
  /** 1-based order of consumption within the run */
  index: number;
  /** index into run.battles of the battle he survived to earn it */
  battle_index: number;
  /** start of the battle whose config first showed the gain (one battle later) */
  ts: string;
  /** floor of the battle he survived */
  floor: number | null;
  /** catalog-style ref (Item_N), or null if the slot could not be read */
  item_ref: string | null;
  gain: BellyStat[];
  attribution: BellyAttribution;
  /** shards the passive generated for this bite, when attributable to one bite */
  shards: number | null;
}

export interface BellyReport {
  /** Niklas was in the party at some point this run */
  present: boolean;
  /** total from the game's own counter (== bites.length; a bite whose item or
   *  stats could not be read is still listed, with what is known) */
  consumed: number;
  /** cumulative shards the passive reports having generated */
  shards_generated: number;
  bites: BellyBite[];
  /** stat gain summed over every bite */
  totals: BellyStat[];
  /** permanent stat mods gained alongside a bite that the eaten items don't
   *  explain — other sources (rank modifiers, relics, events), not the belly */
  other: BellyStat[];
}

/** Stats of one item, as the catalog knows them. */
export interface ItemStat {
  stat: string;
  value: number;
}

export interface BellyOptions {
  /** catalog lookup: Item_N -> its stats, or null when unknown */
  itemStats?: (ref: string) => ItemStat[] | null;
}

interface StatMod {
  stat: number;
  value: number;
}

interface NiklasState {
  consumed: number;
  shards: number;
  mods: StatMod[];
  /** slot order as logged — left-most first, empty slots kept as null */
  slots: (string | null)[];
  /** the battle this state was read from */
  battleIndex: number;
  floor: number | null;
}

const stripSeq = (s: string | undefined): string => (s ?? "").replace("seq:", "");

/** Logs write item refs as tem_N; the catalog uses Item_N. */
const itemRef = (ref: string): string => ref.replace(/^tem_/, "Item_");

const num = (s: string | undefined): number => {
  const v = parseFloat(s ?? "0");
  return Number.isFinite(v) ? v : 0;
};

function niklasStates(battle: Battle, battleIndex: number): Map<string, NiklasState> {
  const out = new Map<string, NiklasState>();
  const cfg: BattleConfig | null = battle.config;
  if (!cfg) return out;
  const all = [...(cfg.HeroDtos ?? []), ...(cfg.ReserveHeroDtos ?? [])] as HeroDto[];
  for (const h of all) {
    if (!h.EntityId || stripSeq(h.CharacterRef) !== NIKLAS_REF) continue;
    const custom = h.PermanentCustomData ?? {};
    out.set(h.EntityId, {
      consumed: num(custom[CONSUMED_KEY]),
      shards: num(custom[SHARDS_KEY]),
      mods: (h.StatModifications ?? []).map((m) => ({ stat: m.Type ?? 0, value: num(m.Value) })),
      slots: (h.EquippedItems ?? []).map((i) => (i?.ItemRef ? itemRef(stripSeq(i.ItemRef)) : null)),
      battleIndex,
      floor: battle.stage?.floor ?? null,
    });
  }
  return out;
}

/** The entries appended to StatModifications since the previous battle. */
function modDelta(prev: StatMod[], cur: StatMod[]): StatMod[] {
  // the list is append-only in practice; if it ever shrinks or is rewritten,
  // fall back to crediting nothing rather than inventing gains
  if (cur.length <= prev.length) return [];
  return cur.slice(prev.length);
}

function addStat(into: Map<number, number>, stat: number, value: number): void {
  into.set(stat, (into.get(stat) ?? 0) + value);
}

function toStats(m: Map<number, number>): BellyStat[] {
  return [...m.entries()]
    .filter(([, value]) => value !== 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([stat, value]) => ({ stat, name: statName(stat), value }));
}

/** Name -> enum id, so catalog stats can be matched against logged StatModifications. */
const STAT_IDS = new Map(Object.entries(STAT_NAMES).map(([id, name]) => [name, Number(id)]));

/**
 * Catalog stat name -> TargetStat id, or -1 when it names nothing placeable.
 *
 * The catalog prints "Stat<n>" for any id it has no name for (STAT_NAMES in
 * tools/catalog/guildrun_sheets.py), so read that back rather than giving up on
 * it: an unresolved id matches no logged StatModifications entry, which would
 * credit the item's PRINTED value here and leave the real logged gain to fall
 * through into `other` — the same gain counted twice, once under "Stat -1".
 */
function statId(name: string): number {
  const known = STAT_IDS.get(name);
  if (known !== undefined) return known;
  const m = /^Stat ?(\d+)$/.exec(name);
  return m ? Number(m[1]) : -1;
}

/** How far a logged value is from being a whole multiple of the item's base. */
function multipleError(base: number, logged: number): number {
  if (base === 0) return Infinity;
  const ratio = logged / base;
  return Math.abs(ratio - Math.round(ratio)) + (ratio < 1 ? 1 : 0); // prefer >= base
}

/**
 * Credit one eaten item out of the battle's StatModifications delta.
 *
 * An item does not always grant its printed stats. Deadeye Hood triples its own
 * stats when its holder is alone in the back row; Assassin's Hood accumulates
 * Crit on kills; effects like these mean the value Niklas keeps can be well
 * above (or below) what the catalog prints. The logged delta is the game's own
 * answer, so it wins whenever the two disagree — the catalog is used to decide
 * WHICH entries belong to this item, not how much they were worth:
 *
 *   1. exact matches first — they are unambiguous, and taking them first stops
 *      an unrelated same-stat gain from being mistaken for an amplified one
 *   2. anything still unmatched must be in the delta somewhere (the counter says
 *      he ate it), so it takes the best remaining entry of the same stat, ranked
 *      by how close it is to a whole multiple of the base — a tripled 20 lands
 *      on 60, not on some unrelated +25
 *
 * Whenever the credited value differs from the catalog's, `base` records what
 * was printed, so the UI can show "+60 (base 20, x3)" rather than silently
 * picking one of the two numbers.
 */
function claimForItem(stats: ItemStat[], unclaimed: StatMod[]): BellyStat[] {
  const gain: BellyStat[] = stats.map(({ stat, value }) => ({
    stat: statId(stat), name: stat, value,
  }));
  const pending: number[] = [];

  gain.forEach((g, i) => {
    const at = unclaimed.findIndex((m) => m.stat === g.stat && m.value === g.value);
    if (at >= 0) unclaimed.splice(at, 1);
    else pending.push(i);
  });

  for (const i of pending) {
    const g = gain[i]!;
    let best = -1;
    for (let j = 0; j < unclaimed.length; j++) {
      if (unclaimed[j]!.stat !== g.stat) continue;
      if (best < 0 ||
          multipleError(g.value, unclaimed[j]!.value) < multipleError(g.value, unclaimed[best]!.value)) {
        best = j;
      }
    }
    if (best < 0) continue; // nothing of this stat was granted; keep the printed value
    const [claimed] = unclaimed.splice(best, 1);
    gain[i] = { ...g, value: claimed!.value, base: g.value };
  }
  return gain;
}

/**
 * Reconstruct the belly for one run's battles, in order.
 *
 * O(battles); safe to re-run on every update — the companion recomputes it for
 * the current run whenever new log lines arrive.
 */
export function trackBelly(battles: Battle[], opts: BellyOptions = {}): BellyReport {
  const bites: BellyBite[] = [];
  const totals = new Map<number, number>();
  const other = new Map<number, number>();
  const prev = new Map<string, NiklasState>();
  const shardsByEntity = new Map<string, number>();
  let present = false;
  let consumed = 0;

  battles.forEach((battle, battleIndex) => {
    const states = niklasStates(battle, battleIndex);
    if (states.size) present = true;

    for (const [entityId, cur] of states) {
      shardsByEntity.set(entityId, cur.shards);
      const before = prev.get(entityId);
      prev.set(entityId, cur);
      if (!before) continue;

      const n = Math.round(cur.consumed - before.consumed);
      if (n <= 0) continue; // no meal (a decrease would mean a fresh run reusing the id)
      consumed += n;

      // he ate off the top of the bags he fought with, left-most first
      const eaten = before.slots.filter((s): s is string => s !== null).slice(0, n);
      const unclaimed = modDelta(before.mods, cur.mods);
      const shardDelta = cur.shards - before.shards;

      for (let k = 0; k < n; k++) {
        const ref = eaten[k] ?? null;
        const stats = ref ? (opts.itemStats?.(ref) ?? null) : null;
        let gain: BellyStat[];
        let attribution: BellyAttribution;

        if (stats?.length) {
          gain = claimForItem(stats, unclaimed);
          attribution = "catalog";
        } else if (k === n - 1 && unclaimed.length) {
          // unknown item: the logged delta is the best evidence there is.
          // Only the last of a multi-bite battle takes it, so the same gain is
          // never credited twice.
          gain = unclaimed.splice(0, unclaimed.length).map((m) => ({
            stat: m.stat, name: statName(m.stat), value: m.value,
          }));
          attribution = "logged";
        } else {
          gain = [];
          attribution = "unknown";
        }

        for (const g of gain) addStat(totals, g.stat, g.value);
        bites.push({
          index: bites.length + 1,
          battle_index: before.battleIndex,
          ts: battle.start_ts,
          floor: before.floor,
          item_ref: ref,
          gain,
          attribution,
          shards: n === 1 && shardDelta > 0 ? shardDelta : null,
        });
      }

      for (const m of unclaimed) addStat(other, m.stat, m.value);
    }
  });

  return {
    present,
    consumed,
    shards_generated: [...shardsByEntity.values()].reduce((a, b) => a + b, 0),
    bites,
    totals: toStats(totals),
    other: toStats(other),
  };
}
