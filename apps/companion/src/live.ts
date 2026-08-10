/**
 * Live game state: feed tailed lines through the shared RunAssembler and
 * derive the compact state the UI renders. All derivation is O(current run),
 * computed only when something actually changed.
 */

import {
  RunAssembler, parseLines, snapshotBattle,
  type Run, type Battle, type Shop, type BattleSnapshot,
} from "@guildrun/parser";

export interface LiveContext {
  difficulty: number;      // 0 = unknown/all
  floor_band: string;      // '1-4' | '6-9' | '10-13' | 'endless' | 'all'
}

export interface LiveState {
  updated_at: string;
  in_run: boolean;
  run: null | {
    seed: number | null;
    difficulty: number | null;
    started: string;
    battles_won: number;
    battles_lost: number;
    lives_lost: number;
    current_floor: number | null;
    stage_kind: string | null;
    beaten_so_far: boolean;
  };
  party: { ref: string; rank: number | null; items: string[] }[];
  relics: string[];
  shards: number | null;
  shop: null | {
    open: boolean;
    sales: { kind: string; name: string }[];
    odds: Record<string, Record<string, number>>;
  };
  context: LiveContext;
}

function floorBand(battle: Battle | null): string {
  const st = battle?.stage;
  if (!st) return "all";
  if (st.kind === "endless") return "endless";
  if (st.floor === null) return "all";
  if (st.floor <= 4) return "1-4";
  if (st.floor <= 9) return "6-9";
  return "10-13";
}

export class LiveGame {
  private assembler = new RunAssembler();
  private dirty = false;
  private cached: LiveState | null = null;

  feedLines(lines: string[], fileName: string): void {
    for (const line of lines) {
      for (const rec of parseLines(line, fileName)) {
        this.assembler.feed(rec);
      }
    }
    if (lines.length) this.dirty = true;
  }

  /** Wipe on rotation to a new file: a fresh assembler re-reads from zero. */
  reset(): void {
    this.assembler = new RunAssembler();
    this.dirty = true;
  }

  changed(): boolean {
    return this.dirty;
  }

  /** Battles of the run the UI is showing — the open one, or the last closed
   *  one right after it ends. Derivations that need catalog data (Niklas'
   *  belly) run over these on the server side, where the catalog lives. */
  runBattles(): Battle[] {
    const open = this.assembler.currentRun();
    const run = open ?? this.assembler.runs[this.assembler.runs.length - 1];
    if (!run) return [];
    // the assembler only pushes a battle once it closes, but the battle now
    // being fought carries the freshest state — a bite shows up in its config
    const inProgress = open ? this.assembler.currentBattle() : null;
    return inProgress ? [...run.battles, inProgress] : run.battles;
  }

  state(): LiveState {
    if (this.cached && !this.dirty) return this.cached;
    this.dirty = false;

    // the open run, or — right after a run ends — the last closed one
    const open = this.assembler.currentRun();
    const run: Run | null = open ?? this.assembler.runs[this.assembler.runs.length - 1] ?? null;
    const battle: Battle | null =
      this.assembler.currentBattle() ?? run?.battles[run.battles.length - 1] ?? null;
    const shop: Shop | null = this.assembler.currentShop();

    const snap: BattleSnapshot | null = snapshotBattle(battle?.config ?? null);
    const party = snap
      ? Object.values(snap.heroes)
          .filter((h) => !h.reserve)
          .map((h) => ({ ref: h.ref, rank: h.rank, items: h.items.map(itemRef) }))
      : [];

    const won = run ? run.battles.filter((b) => b.outcome === "victory").length : 0;
    const lost = run ? run.battles.filter((b) => b.outcome === "defeat").length : 0;

    this.cached = {
      updated_at: new Date().toISOString(),
      in_run: open !== null,
      run: run
        ? {
            seed: run.seed,
            difficulty: run.difficulty,
            started: run.start_ts,
            battles_won: won,
            battles_lost: lost,
            lives_lost: run.lives_lost,
            current_floor: battle?.stage?.floor ?? null,
            stage_kind: battle?.stage?.kind ?? null,
            beaten_so_far: run.battles.some(
              (b) => b.stage?.kind === "endless" ||
                (b.stage?.kind === "campaign" && b.stage.floor === 13 && b.outcome === "victory"),
            ),
          }
        : null,
      party,
      relics: snap ? Object.values(snap.relics) : [],
      shards: snap?.shards ?? null,
      shop: shop
        ? { open: true, sales: shop.sales.map((s) => ({ kind: s.kind, name: s.name })), odds: shop.odds }
        : null,
      context: {
        difficulty: run?.difficulty ?? 0,
        floor_band: open ? floorBand(battle) : "all",
      },
    };
    return this.cached;
  }
}

/** Logs write item refs as tem_N; the catalog/API use Item_N. */
function itemRef(ref: string): string {
  return ref.replace(/^tem_/, "Item_");
}
