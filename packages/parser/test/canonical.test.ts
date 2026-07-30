/**
 * Belt-and-braces parity check: canonical (key-sorted) serialization of the TS
 * output must be byte-identical to the Python golden output, and a negative
 * control proves the comparison actually bites.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGuildrunLogs } from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

function canon(o: unknown): string {
  return JSON.stringify(o, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort())
      : v,
  );
}

describe("canonical serialization parity", () => {
  const dir = join(FIXTURES, "logs");
  const logs = readdirSync(dir)
    .filter((f) => f.endsWith(".log.gz"))
    .sort()
    .map((f) => ({
      name: f.replace(/\.gz$/, ""),
      text: gunzipSync(readFileSync(join(dir, f))).toString("utf-8"),
    }));
  const golden: unknown = JSON.parse(
    gunzipSync(readFileSync(join(FIXTURES, "golden", "runs.json.gz"))).toString("utf-8"),
  );

  it("is byte-identical to the Python golden output when key-sorted", () => {
    const ours: unknown = JSON.parse(JSON.stringify(parseGuildrunLogs(logs).runs));
    expect(canon(ours)).toBe(canon(golden));
  });

  it("negative control: a single mutated field is detected", () => {
    const mutated = JSON.parse(JSON.stringify(parseGuildrunLogs(logs).runs)) as {
      battles: { combat_s: number | null }[];
    }[];
    mutated[5]!.battles[3]!.combat_s = (mutated[5]!.battles[3]!.combat_s ?? 0) + 0.1;
    expect(canon(mutated)).not.toBe(canon(golden));
  });
});
