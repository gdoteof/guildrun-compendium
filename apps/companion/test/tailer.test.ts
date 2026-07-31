/**
 * Tailer behavior: catch-up on start, appended-bytes-only reads, partial-line
 * carry, rotation to a new active file. Uses a temp dir with simulated
 * game-style writes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogTailer } from "../src/tailer.js";

const LINE = (n: number): string =>
  `[2026-07-30 12:00:0${n % 10}.0000] [INFO] [Test.cs] [M:1] line ${n} \n`;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("LogTailer", () => {
  let dir: string;
  let got: string[];
  let rotations: string[];
  let tailer: LogTailer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "guildrun-tail-"));
    got = [];
    rotations = [];
    tailer = new LogTailer(dir, {
      onLines: (lines) => got.push(...lines),
      onRotate: (f) => rotations.push(f),
    });
  });

  afterEach(() => {
    tailer.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("catches up on start and then reads only appended bytes", async () => {
    writeFileSync(join(dir, "2026-07-30-game.log"), LINE(1) + LINE(2));
    const { activeFile } = tailer.start();
    expect(activeFile).toBe("2026-07-30-game.log");
    expect(got).toHaveLength(2);

    const offsetAfterCatchup = tailer.status().offset;
    appendFileSync(join(dir, "2026-07-30-game.log"), LINE(3));
    await wait(400); // watcher event + 150ms debounce
    expect(got).toHaveLength(3);
    expect(got[2]).toContain("line 3");
    // offset advanced by exactly the appended bytes
    expect(tailer.status().offset).toBe(offsetAfterCatchup + LINE(3).length);
  });

  it("carries partial lines across writes", async () => {
    writeFileSync(join(dir, "2026-07-30-game.log"), "");
    tailer.start();
    const full = LINE(7);
    appendFileSync(join(dir, "2026-07-30-game.log"), full.slice(0, 40));
    await wait(400);
    expect(got).toHaveLength(0); // incomplete line withheld
    appendFileSync(join(dir, "2026-07-30-game.log"), full.slice(40));
    await wait(400);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain("line 7");
  });

  it("rotates to a newer active file", async () => {
    writeFileSync(join(dir, "2026-07-30-game.log"), LINE(1));
    tailer.start();
    expect(got).toHaveLength(1);
    writeFileSync(join(dir, "2026-07-31-game.log"), LINE(2));
    await wait(400);
    expect(rotations).toEqual(["2026-07-31-game.log"]);
    expect(got).toHaveLength(2);
    expect(tailer.status().activeFile).toBe("2026-07-31-game.log");
  });

  it("ignores rotated .N.log files when picking the active file", () => {
    writeFileSync(join(dir, "2026-07-30-game.0.log"), LINE(1));
    writeFileSync(join(dir, "2026-07-30-game.log"), LINE(2));
    const { activeFile } = tailer.start();
    expect(activeFile).toBe("2026-07-30-game.log");
    expect(got).toHaveLength(1);
  });

  it("treats in-place truncation as rotation (same-day game restart)", async () => {
    writeFileSync(join(dir, "2026-07-30-game.log"), LINE(1) + LINE(2));
    tailer.start();
    expect(got).toHaveLength(2);
    // restart: NLog archives the old content and rewrites the active file
    writeFileSync(join(dir, "2026-07-30-game.log"), LINE(3));
    await wait(400);
    expect(rotations).toEqual(["2026-07-30-game.log"]);
    expect(got).toHaveLength(3);
    expect(got[2]).toContain("line 3");
  });
});
