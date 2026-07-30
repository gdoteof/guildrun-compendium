/**
 * Guildrun log parser — TypeScript port of tools/catalog/guildrun_parse_reference.py.
 *
 * The port is deliberately line-for-line faithful, including quirks (e.g. the
 * tutorial-shop-override line creating a fresh shop, battle_kind consuming a
 * pending value set before board init). Golden-fixture tests compare the full
 * output structurally against the Python reference on 13 real log files, so
 * any behavioral drift fails CI.
 *
 * Pure functions, no I/O: runs in Cloudflare Workers, Node, and (later) the
 * companion app tailing live logs.
 */

import type {
  Battle, BattleConfig, LogRecord, ParseResult, Run, Session, Shop,
} from "./types.js";
import { parseStage } from "./stage.js";
import { pyRound } from "./pyround.js";

const LINE_RE =
  /^\[(?<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\] \[(?<level>[A-Z]+)\] \[(?<src>[^\]]+)\] (?:\[(?<method>[A-Za-z_0-9]+):(?<srcline>\d+)\] )?(?<msg>.*)$/;

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

/** Tokenize raw log text into structured records (continuation lines of
 * multi-line messages don't match and are skipped, as in the reference). */
export function parseLines(text: string, fileName: string): LogRecord[] {
  const records: LogRecord[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const m = LINE_RE.exec(line);
    if (!m?.groups) continue;
    records.push({
      ts: m.groups["ts"]!,
      level: m.groups["level"]!,
      src: m.groups["src"]!,
      method: m.groups["method"] ?? null,
      srcline: m.groups["srcline"] ?? null,
      msg: m.groups["msg"]!.replace(/\s+$/, ""),
      file: fileName,
    });
  }
  return records;
}

export interface LogFile {
  name: string;
  text: string;
}

export function parseGuildrunLogs(files: LogFile[]): ParseResult {
  const records: LogRecord[] = [];
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    records.push(...parseLines(f.text, f.name));
  }
  // stable sort by timestamp string (lexicographic == chronological)
  records.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const runs: Run[] = [];
  const sessions: Session[] = [];

  let session: Session | null = null;
  let run: Run | null = null;
  let battle: Battle | null = null;
  let shop: Shop | null = null;
  let pendingKind: string | null = null;

  const closeBattle = (outcome: "victory" | "defeat" | null = null, ts: string | null = null): void => {
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
    if (run !== null) run.battles.push(battle);
    battle = null;
  };

  const closeRun = (ts: string | null = null, reason: string | null = null): void => {
    if (run === null) return;
    closeBattle(null, ts);
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
    runs.push(run);
    run = null;
  };

  for (const r of records) {
    const { ts, src, method: meth, msg } = r;

    // ---- session boundaries ----
    if (src === "ApplicationScope.cs" && meth === "InitializeApplication") {
      closeRun(ts, "app restart");
      session = { start_ts: ts, log_file: r.file, runs: 0 };
      sessions.push(session);
      continue;
    }

    if (src === "ProgressionService.cs" && meth === "TryLoadProgressionData") {
      const m = RE.progression.exec(msg);
      if (m && session) {
        session.progression_at_launch = {
          total_started_runs: parseInt(m[1]!, 10),
          runs_beaten: parseInt(m[2]!, 10),
          highest_difficulty_beaten: parseInt(m[3]!, 10),
          tutorial_steps_done: parseInt(m[4]!, 10),
        };
      }
      continue;
    }

    // ---- run boundaries ----
    if (src === "ProgressionService.cs" && meth === "OnRunStarted") {
      closeRun(ts, "new run started");
      run = {
        start_ts: ts, log_file: r.file, seed: null, difficulty: null,
        battles: [], shops: [], crossroads: [], events: [], relics_granted: [],
        heroes_created: [], rank_ups: [], lives_lost: 0, endless_maps: null,
        act_boss_relics: [],
      };
      if (session) session.runs += 1;
      continue;
    }

    if (src === "RunSessionService.cs" && meth === "Init") {
      let m = RE.seedInit.exec(msg);
      if (m && run !== null) {
        run.seed = parseInt(m[1]!, 10);
        run.endless_maps = parseInt(m[2]!, 10);
      }
      m = RE.seedExisting.exec(msg);
      if (m && run !== null) {
        run.seed = parseInt(m[1]!, 10);
        run.resumed = true;
      }
      continue;
    }

    if (src === "DifficultyService.cs" && meth === "OnActStarted") {
      const m = RE.actStarted.exec(msg);
      if (m && run !== null) {
        const st = parseStage(m[1]!);
        run.act_boss_relics.push({ stage: st, relic_ref: m[2]! });
        if (st && st.difficulty) run.difficulty = st.difficulty;
      }
      continue;
    }

    // ---- battles ----
    if (src === "BoardService.cs" && meth === "InitializeBoard") {
      // NB: enemy placement is logged from InitializeBoard too, so match it
      // before the "new board" branch swallows the line.
      const mm = RE.enemyPlaced.exec(msg);
      if (mm) {
        if (battle !== null) {
          battle.enemy_positions.push([parseInt(mm[2]!, 10), parseInt(mm[3]!, 10)]);
        }
        continue;
      }
      const m = RE.boardInit.exec(msg);
      if (m) {
        closeBattle(null, ts);
        const pendingStage = parseStage(m[1]!);
        battle = {
          stage: pendingStage, start_ts: ts, sim_seed: null, deaths: [],
          outcome: null, enemy_positions: [], hero_positions: [], swaps: 0,
          config: null, battle_kind: pendingKind,
        };
        pendingKind = null;
        if (run !== null && run.difficulty === null && pendingStage) {
          run.difficulty = pendingStage.difficulty;
        }
        continue;
      }
    }

    if (battle !== null && src === "BoardService.cs") {
      const mh = RE.heroPlaced.exec(msg);
      if (mh) {
        battle.hero_positions.push({
          guid: mh[1]!,
          pos: [parseInt(mh[2]!, 10), parseInt(mh[3]!, 10)],
        });
        continue;
      }
      if (meth === "SwapBoardPositions") {
        battle.swaps += 1;
        continue;
      }
    }

    if (src === "RunSessionService.cs" && meth === "StartNextBattle") {
      // logged just *before* the board for that battle is initialised
      pendingKind = msg.replaceAll("Starting ", "").replaceAll(" battle", "").trim();
      continue;
    }

    if (src === "BattleSimulationService.cs" && meth === "StartSimulation") {
      const m = RE.simSeed.exec(msg);
      if (m && battle !== null) {
        battle.sim_seed = parseInt(m[1]!, 10);
        battle.sim_start_ts = ts;
      }
      continue;
    }

    if (src === "BattleSimulationService.cs" && meth === "LogBattle") {
      const m = RE.logBattle.exec(msg);
      if (m) {
        let cfg: BattleConfig;
        try {
          cfg = JSON.parse(m[1]!) as BattleConfig;
        } catch {
          continue;
        }
        if (battle !== null) battle.config = cfg;
      }
      continue;
    }

    if (src === "EntityDeathSystem.cs" && meth === "Tick") {
      const name = msg.replaceAll(" has died", "").trim();
      if (battle !== null) battle.deaths.push({ name, ts });
      continue;
    }

    if (src === "EndConditionSystem.cs" && meth === "Tick") {
      if (msg.includes("All enemies are dead") || msg.includes("Forced end of combat: Victory")) {
        closeBattle("victory", ts);
      } else if (msg.includes("All players are dead") || msg.includes("Forced end of combat: Defeat")) {
        closeBattle("defeat", ts);
      }
      continue;
    }

    // ---- shop ----
    if (src === "ShopService.cs") {
      if (meth === "BuildShop") {
        const last = run?.battles[run.battles.length - 1];
        shop = {
          ts, odds: {}, sales: [],
          after_floor: run && run.battles.length && last?.stage ? last.stage.floor : null,
        };
        if (run !== null) run.shops.push(shop);
        continue;
      }
      if (meth === "DebugPrintChances") {
        const m = RE.shopChances.exec(msg);
        if (m && shop !== null) {
          const tiers: Record<string, number> = {};
          for (const t of m[2]!.matchAll(RE.shopTier)) {
            tiers[t[1]!.trim()] = parseFloat(t[2]!);
          }
          shop.odds[m[1]!] = tiers;
        }
        continue;
      }
      let m = RE.shopSale.exec(msg);
      if (m && shop !== null) {
        shop.sales.push({
          kind: m[1] as "hero" | "item" | "relic",
          name: m[2]!,
          index: parseInt(m[3]!, 10),
        });
        continue;
      }
      m = RE.costDelta.exec(msg);
      if (m && run !== null) {
        (run.item_cost_deltas ??= []).push(parseInt(m[2]!, 10));
      }
      continue;
    }

    if (src === "ShopServiceAnalyticsBuilder.cs" && meth === "HandleShopClosed") {
      const m = RE.shopClosed.exec(msg);
      if (m && shop !== null) {
        const g = m.slice(1).map((x) => parseInt(x!, 10));
        shop.closed = {
          heroes_bought: g[0]!, heroes_offered_unbought: g[1]!, heroes_sold: g[2]!,
          items_bought: g[3]!, items_offered_unbought: g[4]!, items_sold: g[5]!,
          relics_bought: g[6]!, relics_offered_unbought: g[7]!,
        };
        shop = null;
      }
      continue;
    }

    // ---- economy / roster ----
    if (src === "PlayerService.cs") {
      const mg = RE.grantRelic.exec(msg);
      if (mg) {
        if (run !== null) run.relics_granted.push({ name: mg[1]!, guid: mg[2]!, ts });
        continue;
      }
      if (meth === "DecrementLife") {
        if (run !== null) {
          run.lives_lost += 1;
          if (msg.includes("no active stabilizer")) run.died_without_stabilizer = true;
        }
        continue;
      }
      const ms = RE.shardInterest.exec(msg);
      if (ms && run !== null) {
        (run.shard_interest ??= []).push(parseInt(ms[1]!, 10));
        continue;
      }
      continue;
    }

    if (src === "GameRegistryService.cs") {
      const mc = RE.heroCreated.exec(msg);
      if (mc) {
        if (run !== null) run.heroes_created.push({ name: mc[1]!, guid: mc[2]!, ts });
        continue;
      }
      const mr = RE.rankUp.exec(msg);
      if (mr && run !== null) {
        run.rank_ups.push({ name: mr[1]!, to_rank: mr[2]!, ts });
        continue;
      }
      continue;
    }

    // ---- narrative ----
    if (src === "CrossroadsService.cs" && meth === "SetupSelectedCrossroadsPath") {
      const m = RE.crossroads.exec(msg);
      if (m && run !== null) {
        run.crossroads.push({ text: m[1]!.trim(), index: parseInt(m[2]!, 10), ts });
      }
      continue;
    }

    if (src === "EventService.cs" && meth === "SetActiveEvent") {
      const m = RE.setEvent.exec(msg);
      if (m && run !== null) {
        run.events.push({ name: m[1]!.trim(), ts });
      }
      continue;
    }
  }

  closeRun(records.length ? records[records.length - 1]!.ts : null, "end of logs");

  return { runs, sessions, recordCount: records.length };
}
