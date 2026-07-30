/**
 * Shop-phase reconstruction: diffing consecutive battle configs of a known run
 * must reproduce the shop activity we manually verified during exploration
 * (run seed 21112243, opening -> floor 1: Gustav & Grace joined, one starter-kit
 * relic granted, one reroll, 8 shards net spend).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGuildrunLogs, snapshotBattle, diffSnapshots } from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

describe("battle-config diff (shop reconstruction)", () => {
  const dir = join(FIXTURES, "logs");
  const logs = readdirSync(dir)
    .filter((f) => f.endsWith(".log.gz"))
    .sort()
    .map((f) => ({
      name: f.replace(/\.gz$/, ""),
      text: gunzipSync(readFileSync(join(dir, f))).toString("utf-8"),
    }));
  const { runs } = parseGuildrunLogs(logs);
  const run = runs.find((r) => r.seed === 21112243)!;

  it("reconstructs the first shop phase of run 21112243", () => {
    const prev = snapshotBattle(run.battles[0]!.config)!;
    const cur = snapshotBattle(run.battles[1]!.config)!;
    const d = diffSnapshots(prev, cur);

    expect(d.joined.map((h) => h.ref).sort()).toEqual(["Hero_16", "Hero_27"]); // Gustav, Grace
    expect(d.relics_gained).toHaveLength(1);
    expect(d.relics_gained[0]).toMatch(/^Relic_\d+$/);
    expect(d.rerolls).toBe(1);
    expect(d.net_shards_spent).toBe(8); // 15 -> 7
    expect(d.left).toHaveLength(0);
    expect(d.ranked).toHaveLength(0);
  });

  it("every consecutive battle pair in every run diffs without throwing", () => {
    let phases = 0;
    for (const r of runs) {
      let prev = null;
      for (const b of r.battles) {
        const snap = snapshotBattle(b.config);
        if (snap && prev) {
          diffSnapshots(prev, snap);
          phases++;
        }
        if (snap) prev = snap;
      }
    }
    expect(phases).toBeGreaterThan(350);
  });
});
