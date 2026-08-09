/**
 * Niklas' Belly reconstruction, against the fixture logs.
 *
 * Run seed 601558719 is the reference meal plan: Niklas ate six items over
 * floors 1-8. Each expectation below was read off the raw battle configs by
 * hand (counter delta, StatModifications delta, and his slot order in the
 * battle he survived) before the tracker existed.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGuildrunLogs, trackBelly, type Battle, type ItemStat } from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

/** Catalog excerpt — only the items Niklas eats in the fixtures. */
const ITEM_STATS: Record<string, ItemStat[]> = {
  Item_109: [{ stat: "Mana Regen", value: 2 }, { stat: "Attack Speed", value: 10 }],
  Item_114: [{ stat: "Max HP", value: 100 }, { stat: "Magic", value: 12 }],
  Item_119: [{ stat: "Crit", value: 15 }],
  Item_125: [{ stat: "Attack Speed", value: 10 }, { stat: "Omnivamp", value: 7 }],
  Item_416: [{ stat: "Max HP", value: 200 }],
  Item_421: [{ stat: "Crit", value: 15 }],
  Item_610: [{ stat: "Crit", value: 15 }, { stat: "Magic", value: 25 }],
  Item_627: [{ stat: "Attack Speed", value: 40 }],
  Item_636: [{ stat: "Max HP", value: 200 }, { stat: "Magic", value: 25 }],
  Item_639: [{ stat: "Mana Regen", value: 4 }, { stat: "HP/S", value: 10 }],
};
const itemStats = (ref: string): ItemStat[] | null => ITEM_STATS[ref] ?? null;

/** A run of hand-built battles carrying just the Niklas state under test. */
function niklasRun(
  steps: { items: string[]; consumed: number; mods: [number, number][] }[],
): Battle[] {
  return steps.map((s, i) => ({
    stage: { raw: "", difficulty: 1, floor: i + 1, variant: null, kind: "campaign" as const },
    start_ts: `2026-07-29 21:0${i}:00.0000`,
    sim_seed: null, deaths: [], outcome: "victory" as const,
    enemy_positions: [], hero_positions: [], swaps: 0, battle_kind: null,
    config: {
      HeroDtos: [{
        EntityId: "niklas-1",
        CharacterRef: "seq:Hero_9",
        EquippedItems: s.items.map((ref) => ({ ItemRef: ref.replace("Item_", "seq:tem_") })),
        StatModifications: s.mods.map(([Type, v]) => ({ Type, Value: v.toFixed(2) })),
        PermanentCustomData: { niklasItemsConsumedCount: s.consumed.toFixed(2) },
      }],
    },
  }));
}

describe("Niklas' Belly", () => {
  const dir = join(FIXTURES, "logs");
  const logs = readdirSync(dir)
    .filter((f) => f.endsWith(".log.gz"))
    .sort()
    .map((f) => ({
      name: f.replace(/\.gz$/, ""),
      text: gunzipSync(readFileSync(join(dir, f))).toString("utf-8"),
    }));
  const { runs } = parseGuildrunLogs(logs);
  const run = runs.find((r) => r.seed === 601558719)!;

  it("reconstructs the six-item run in order, with the stats each granted", () => {
    const belly = trackBelly(run.battles, { itemStats });

    expect(belly.present).toBe(true);
    expect(belly.consumed).toBe(6);
    expect(belly.bites.map((b) => b.item_ref)).toEqual([
      "Item_610", "Item_416", "Item_119", "Item_636", "Item_639", "Item_109",
    ]);
    expect(belly.bites.map((b) => b.floor)).toEqual([1, 2, 4, 6, 7, 8]);
    expect(belly.bites.every((b) => b.attribution === "catalog")).toBe(true);

    // per item: Battlemage Robes granted Max HP 200 + Magic 25
    expect(belly.bites[3]!.gain).toEqual([
      { stat: 1, name: "Max HP", value: 200 },
      { stat: 7, name: "Magic", value: 25 },
    ]);

    // totals across the run, biggest first
    expect(belly.totals).toEqual([
      { stat: 1, name: "Max HP", value: 400 },
      { stat: 7, name: "Magic", value: 50 },
      { stat: 11, name: "Crit", value: 30 },
      { stat: 9, name: "Attack Speed", value: 10 },
      { stat: 15, name: "HP/S", value: 10 },
      { stat: 12, name: "Mana Regen", value: 6 },
    ]);

    // the passive's own shard tracker: 80% of item value, per rarity
    expect(belly.shards_generated).toBe(48);
    expect(belly.bites.map((b) => b.shards)).toEqual([12, 4, 4, 12, 12, 4]);

    // every logged stat gain that run was explained by an eaten item
    expect(belly.other).toEqual([]);
  });

  it("keeps stat gains from other sources out of the belly", () => {
    // seed 1899316504: one bite (Nimble Boots, +40 Attack Speed) in the same
    // battle as an unrelated +25 Attack Speed from elsewhere
    const other = runs.find((r) => r.seed === 1899316504)!;
    const belly = trackBelly(other.battles, { itemStats });

    expect(belly.bites).toHaveLength(1);
    expect(belly.totals).toEqual([{ stat: 9, name: "Attack Speed", value: 40 }]);
    expect(belly.other).toEqual([{ stat: 9, name: "Attack Speed", value: 25 }]);
  });

  it("falls back to the logged stat delta when the item is not in the catalog", () => {
    const belly = trackBelly(run.battles); // no catalog at all

    expect(belly.consumed).toBe(6);
    expect(belly.bites.every((b) => b.attribution === "logged")).toBe(true);
    expect(belly.totals).toEqual([
      { stat: 1, name: "Max HP", value: 400 },
      { stat: 7, name: "Magic", value: 50 },
      { stat: 11, name: "Crit", value: 30 },
      { stat: 9, name: "Attack Speed", value: 10 },
      { stat: 15, name: "HP/S", value: 10 },
      { stat: 12, name: "Mana Regen", value: 6 },
    ]);
  });

  it("credits what the game granted, not what the item prints", () => {
    // Deadeye Hood (Item_631) prints Attack Speed 20 / Crit 15, but triples its
    // own stats when its holder is alone in the back row. If Niklas eats it in
    // that state the log shows the tripled grant — which is the number that
    // matters, so it is the number the belly reports, with the printed value
    // kept alongside it.
    const belly = trackBelly(
      niklasRun([
        { items: ["Item_631"], consumed: 0, mods: [] },
        { items: [], consumed: 1, mods: [[9, 60], [11, 45]] },
      ]),
      { itemStats: () => [{ stat: "Attack Speed", value: 20 }, { stat: "Crit", value: 15 }] },
    );

    expect(belly.bites[0]!.gain).toEqual([
      { stat: 9, name: "Attack Speed", value: 60, base: 20 },
      { stat: 11, name: "Crit", value: 45, base: 15 },
    ]);
    expect(belly.totals).toEqual([
      { stat: 9, name: "Attack Speed", value: 60 },
      { stat: 11, name: "Crit", value: 45 },
    ]);
    expect(belly.other).toEqual([]); // no phantom "other source" gain
  });

  it("tells an amplified grant apart from an unrelated gain of the same stat", () => {
    // +120 is the tripled item; the +25 Attack Speed that landed the same battle
    // came from somewhere else and must not be mistaken for the item's grant
    const belly = trackBelly(
      niklasRun([
        { items: ["Item_627"], consumed: 0, mods: [] },
        { items: [], consumed: 1, mods: [[9, 25], [9, 120]] },
      ]),
      { itemStats: () => [{ stat: "Attack Speed", value: 40 }] },
    );

    expect(belly.bites[0]!.gain).toEqual([{ stat: 9, name: "Attack Speed", value: 120, base: 40 }]);
    expect(belly.other).toEqual([{ stat: 9, name: "Attack Speed", value: 25 }]);
  });

  it("reports an empty belly for runs without Niklas, and never throws", () => {
    const withNiklas = runs.filter((r) => trackBelly(r.battles, { itemStats }).present);
    expect(withNiklas.length).toBeGreaterThan(0);

    const without = runs.find((r) => !trackBelly(r.battles, { itemStats }).present)!;
    const belly = trackBelly(without.battles, { itemStats });
    expect(belly).toMatchObject({ present: false, consumed: 0, bites: [], totals: [] });
  });
});
