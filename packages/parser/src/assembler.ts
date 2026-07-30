/**
 * RunAssembler — the parser's assembly loop as an incremental state machine.
 *
 * Two consumers share this exact code path:
 *   - batch: parseGuildrunLogs() sorts all records then feeds them through one
 *     assembler (golden-fixture tests pin this to the Python reference), and
 *   - streaming: the companion app feeds records as the game appends them,
 *     reading live state via currentRun()/currentBattle()/currentShop().
 *
 * The handler chain is a faithful transcription of the reference parser —
 * order and quirks preserved deliberately; the golden tests fail on any drift.
 */

import type { Battle, BattleConfig, LogRecord, Run, Session, Shop } from "./types.js";
import { parseStage } from "./stage.js";
import { pyRound } from "./pyround.js";

const GUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const RE = {
  progression: /(\d+) total started runs and (\d+) runs beaten\. Highest difficulty beaten is (\d+)\. Total completed tutorial steps is (\d+)/,
  seedInit: /Run session initialized with seed (-?\d+)\. Endless maps: (\d+)/,
  seedExisting: /Using existing seed for run session: (-?\d+)/,
  actStarted: /stage: (Stage_\d+), relic: (Relic_\d+)/,
  enemyPlaced: new RegExp(`Placed enemy (${GUID}) at \\((\\d+), (\\d+)\\)`),
  boardInit: /Initializing board for stage (Stage_\d+)/,
  heroPlaced: new RegExp(`Added new hero (${GUID}) to position \\((\\d+), (\\d+)\\)`),
  simSeed: /Starting simulation with seed (-?\d+)/,
  logBattle: /Starting battle with config: (\{.*\})/,
  shopChances: /^Randomized (\w+) choices with chances:(.*)/,
  shopTier: /\[([^:\]]+): (-?[\d.]+)\]/g,
  shopSale: /Shop sale applied to (hero|item|relic) (.+?) at index (\d+)/,
  costDelta: /Modified item cost delta by (-?\d+)\. New delta: (-?\d+)/,
  shopClosed: /Heroes purchased: (\d+) \(Not purchased: (\d+), Sold: (\d+)\), Items purchased: (\d+) \(Not purchased: (\d+), Sold: (\d+)\), Relics purchased: (\d+) \(Not purchased: (\d+)\)/,
  grantRelic: new RegExp(`Granting relic (.+?) \\((${GUID})\\)`),
  shardInterest: /Gaining (\d+) shard interest/,
  heroCreated: new RegExp(`Added new hero (.+?) \\((${GUID})\\)`),
  rankUp: /Ranked up hero (.+?) to rank ([A-Z])/,
  crossroads: /Selected crossroads path: ([\s\S]*?) \(index (\d+)\)/,
  setEvent: /Set active event to: (.+)/,
  timestamp: /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d+)$/,
};

/** Timestamp -> integer microseconds. Mirrors datetime.strptime("%f"): the
 * fractional digits are a fraction of a second (right-padded to 6). */
function toMicros(ts: string): number | null {
  const m = RE.timestamp.exec(ts);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  const micros = parseInt((frac! + "000000").slice(0, 6), 10);
  const ms = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!);
  return ms * 1000 + micros;
}

/** Seconds between two timestamps, rounded like Python's round(x, 1). */
function secs(a: string | undefined, b: string | undefined): number | null {
  if (!a || !b) return null;
  const ma = toMicros(a);
  const mb = toMicros(b);
  if (ma === null || mb === null) return null;
  return pyRound((mb - ma) / 1e6, 1);
}

export class RunAssembler {
  readonly runs: Run[] = [];
  readonly sessions: Session[] = [];
  recordCount = 0;

  private session: Session | null = null;
  private run: Run | null = null;
  private battle: Battle | null = null;
  private shop: Shop | null = null;
  private pendingKind: string | null = null;
  private lastTs: string | null = null;
  private finished = false;

  /** The in-progress (not yet closed) run — streaming consumers only. */
  currentRun(): Run | null {
    return this.run;
  }

  /** The in-progress battle (board placed, outcome pending). */
  currentBattle(): Battle | null {
    return this.battle;
  }

  /** The shop currently open (built, not yet closed). */
  currentShop(): Shop | null {
    return this.shop;
  }

  /** Close any open run as of the last record seen. Batch mode only —
   * streaming consumers never finish. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.closeRun(this.lastTs, "end of logs");
  }

  private closeBattle(outcome: "victory" | "defeat" | null = null, ts: string | null = null): void {
    const battle = this.battle;
    if (battle === null) return;
    if (outcome) battle.outcome = outcome;
    // board init -> simulation start is the player's placement/planning phase;
    // simulation start -> end condition is the auto-battle itself.
    if (ts && battle.sim_start_ts) {
      battle.combat_s = secs(battle.sim_start_ts, ts);
      battle.planning_s = secs(battle.start_ts, battle.sim_start_ts);
    } else if (ts) {
      battle.combat_s = null;
      battle.planning_s = null;
    }
    if (this.run !== null) this.run.battles.push(battle);
    this.battle = null;
  }

  private closeRun(ts: string | null = null, reason: string | null = null): void {
    const run = this.run;
    if (run === null) return;
    this.closeBattle(null, ts);
    run.end_ts = ts;
    run.end_reason = reason;
    const outcomes = run.battles.map((b) => b.outcome);
    run.battles_won = outcomes.filter((o) => o === "victory").length;
    run.battles_lost = outcomes.filter((o) => o === "defeat").length;
    const floors = run.battles
      .filter((b) => b.stage && b.stage.floor !== null)
      .map((b) => b.stage!.floor!);
    run.floors_reached = floors.length ? Math.max(...floors) : 0;
    // A run counts as beaten once floor 13 is cleared. Clearing it drops the
    // player into endless mode, so reaching an endless stage also implies it.
    run.beaten = run.battles.some(
      (b) =>
        b.stage &&
        (b.stage.kind === "endless" ||
          (b.stage.kind === "campaign" && b.stage.floor === 13 && b.outcome === "victory")),
    );
    run.endless_battles = run.battles.filter((b) => b.stage?.kind === "endless").length;
    run.event_fights = run.battles.filter((b) => b.stage?.kind === "event_fight").length;
    this.runs.push(run);
    this.run = null;
  }

  feed(r: LogRecord): void {
    this.recordCount += 1;
    this.lastTs = r.ts;
    const { ts, src, method: meth, msg } = r;

    // ---- session boundaries ----
    if (src === "ApplicationScope.cs" && meth === "InitializeApplication") {
      this.closeRun(ts, "app restart");
      this.session = { start_ts: ts, log_file: r.file, runs: 0 };
      this.sessions.push(this.session);
      return;
    }

    if (src === "ProgressionService.cs" && meth === "TryLoadProgressionData") {
      const m = RE.progression.exec(msg);
      if (m && this.session) {
        this.session.progression_at_launch = {
          total_started_runs: parseInt(m[1]!, 10),
          runs_beaten: parseInt(m[2]!, 10),
          highest_difficulty_beaten: parseInt(m[3]!, 10),
          tutorial_steps_done: parseInt(m[4]!, 10),
        };
      }
      return;
    }

    // ---- run boundaries ----
    if (src === "ProgressionService.cs" && meth === "OnRunStarted") {
      this.closeRun(ts, "new run started");
      this.run = {
        start_ts: ts, log_file: r.file, seed: null, difficulty: null,
        battles: [], shops: [], crossroads: [], events: [], relics_granted: [],
        heroes_created: [], rank_ups: [], lives_lost: 0, endless_maps: null,
        act_boss_relics: [],
      };
      if (this.session) this.session.runs += 1;
      return;
    }

    if (src === "RunSessionService.cs" && meth === "Init") {
      let m = RE.seedInit.exec(msg);
      if (m && this.run !== null) {
        this.run.seed = parseInt(m[1]!, 10);
        this.run.endless_maps = parseInt(m[2]!, 10);
      }
      m = RE.seedExisting.exec(msg);
      if (m && this.run !== null) {
        this.run.seed = parseInt(m[1]!, 10);
        this.run.resumed = true;
      }
      return;
    }

    if (src === "DifficultyService.cs" && meth === "OnActStarted") {
      const m = RE.actStarted.exec(msg);
      if (m && this.run !== null) {
        const st = parseStage(m[1]!);
        this.run.act_boss_relics.push({ stage: st, relic_ref: m[2]! });
        if (st && st.difficulty) this.run.difficulty = st.difficulty;
      }
      return;
    }

    // ---- battles ----
    if (src === "BoardService.cs" && meth === "InitializeBoard") {
      // NB: enemy placement is logged from InitializeBoard too, so match it
      // before the "new board" branch swallows the line.
      const mm = RE.enemyPlaced.exec(msg);
      if (mm) {
        if (this.battle !== null) {
          this.battle.enemy_positions.push([parseInt(mm[2]!, 10), parseInt(mm[3]!, 10)]);
        }
        return;
      }
      const m = RE.boardInit.exec(msg);
      if (m) {
        this.closeBattle(null, ts);
        const pendingStage = parseStage(m[1]!);
        this.battle = {
          stage: pendingStage, start_ts: ts, sim_seed: null, deaths: [],
          outcome: null, enemy_positions: [], hero_positions: [], swaps: 0,
          config: null, battle_kind: this.pendingKind,
        };
        this.pendingKind = null;
        if (this.run !== null && this.run.difficulty === null && pendingStage) {
          this.run.difficulty = pendingStage.difficulty;
        }
        return;
      }
    }

    if (this.battle !== null && src === "BoardService.cs") {
      const mh = RE.heroPlaced.exec(msg);
      if (mh) {
        this.battle.hero_positions.push({
          guid: mh[1]!,
          pos: [parseInt(mh[2]!, 10), parseInt(mh[3]!, 10)],
        });
        return;
      }
      if (meth === "SwapBoardPositions") {
        this.battle.swaps += 1;
        return;
      }
    }

    if (src === "RunSessionService.cs" && meth === "StartNextBattle") {
      // logged just *before* the board for that battle is initialised
      this.pendingKind = msg.replaceAll("Starting ", "").replaceAll(" battle", "").trim();
      return;
    }

    if (src === "BattleSimulationService.cs" && meth === "StartSimulation") {
      const m = RE.simSeed.exec(msg);
      if (m && this.battle !== null) {
        this.battle.sim_seed = parseInt(m[1]!, 10);
        this.battle.sim_start_ts = ts;
      }
      return;
    }

    if (src === "BattleSimulationService.cs" && meth === "LogBattle") {
      const m = RE.logBattle.exec(msg);
      if (m) {
        let cfg: BattleConfig;
        try {
          cfg = JSON.parse(m[1]!) as BattleConfig;
        } catch {
          return;
        }
        if (this.battle !== null) this.battle.config = cfg;
      }
      return;
    }

    if (src === "EntityDeathSystem.cs" && meth === "Tick") {
      const name = msg.replaceAll(" has died", "").trim();
      if (this.battle !== null) this.battle.deaths.push({ name, ts });
      return;
    }

    if (src === "EndConditionSystem.cs" && meth === "Tick") {
      if (msg.includes("All enemies are dead") || msg.includes("Forced end of combat: Victory")) {
        this.closeBattle("victory", ts);
      } else if (msg.includes("All players are dead") || msg.includes("Forced end of combat: Defeat")) {
        this.closeBattle("defeat", ts);
      }
      return;
    }

    // ---- shop ----
    if (src === "ShopService.cs") {
      if (meth === "BuildShop") {
        const last = this.run?.battles[this.run.battles.length - 1];
        this.shop = {
          ts, odds: {}, sales: [],
          after_floor: this.run && this.run.battles.length && last?.stage ? last.stage.floor : null,
        };
        if (this.run !== null) this.run.shops.push(this.shop);
        return;
      }
      if (meth === "DebugPrintChances") {
        const m = RE.shopChances.exec(msg);
        if (m && this.shop !== null) {
          const tiers: Record<string, number> = {};
          for (const t of m[2]!.matchAll(RE.shopTier)) {
            tiers[t[1]!.trim()] = parseFloat(t[2]!);
          }
          this.shop.odds[m[1]!] = tiers;
        }
        return;
      }
      let m = RE.shopSale.exec(msg);
      if (m && this.shop !== null) {
        this.shop.sales.push({
          kind: m[1] as "hero" | "item" | "relic",
          name: m[2]!,
          index: parseInt(m[3]!, 10),
        });
        return;
      }
      m = RE.costDelta.exec(msg);
      if (m && this.run !== null) {
        (this.run.item_cost_deltas ??= []).push(parseInt(m[2]!, 10));
      }
      return;
    }

    if (src === "ShopServiceAnalyticsBuilder.cs" && meth === "HandleShopClosed") {
      const m = RE.shopClosed.exec(msg);
      if (m && this.shop !== null) {
        const g = m.slice(1).map((x) => parseInt(x!, 10));
        this.shop.closed = {
          heroes_bought: g[0]!, heroes_offered_unbought: g[1]!, heroes_sold: g[2]!,
          items_bought: g[3]!, items_offered_unbought: g[4]!, items_sold: g[5]!,
          relics_bought: g[6]!, relics_offered_unbought: g[7]!,
        };
        this.shop = null;
      }
      return;
    }

    // ---- economy / roster ----
    if (src === "PlayerService.cs") {
      const mg = RE.grantRelic.exec(msg);
      if (mg) {
        if (this.run !== null) {
          this.run.relics_granted.push({ name: mg[1]!, guid: mg[2]!, ts });
        }
        return;
      }
      if (meth === "DecrementLife") {
        if (this.run !== null) {
          this.run.lives_lost += 1;
          if (msg.includes("no active stabilizer")) this.run.died_without_stabilizer = true;
        }
        return;
      }
      const ms = RE.shardInterest.exec(msg);
      if (ms && this.run !== null) {
        (this.run.shard_interest ??= []).push(parseInt(ms[1]!, 10));
        return;
      }
      return;
    }

    if (src === "GameRegistryService.cs") {
      const mc = RE.heroCreated.exec(msg);
      if (mc) {
        if (this.run !== null) {
          this.run.heroes_created.push({ name: mc[1]!, guid: mc[2]!, ts });
        }
        return;
      }
      const mr = RE.rankUp.exec(msg);
      if (mr && this.run !== null) {
        this.run.rank_ups.push({ name: mr[1]!, to_rank: mr[2]!, ts });
        return;
      }
      return;
    }

    // ---- narrative ----
    if (src === "CrossroadsService.cs" && meth === "SetupSelectedCrossroadsPath") {
      const m = RE.crossroads.exec(msg);
      if (m && this.run !== null) {
        this.run.crossroads.push({ text: m[1]!.trim(), index: parseInt(m[2]!, 10), ts });
      }
      return;
    }

    if (src === "EventService.cs" && meth === "SetActiveEvent") {
      const m = RE.setEvent.exec(msg);
      if (m && this.run !== null) {
        this.run.events.push({ name: m[1]!.trim(), ts });
      }
      return;
    }
  }
}
