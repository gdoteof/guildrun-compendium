/**
 * Output shapes of the Guildrun log parser.
 *
 * These mirror the Python reference implementation (tools/catalog/
 * guildrun_parse_reference.py) exactly — golden-fixture tests compare the two
 * structurally, so field presence/absence and null-vs-missing must match the
 * reference. Optional fields below are ones the reference only sets when the
 * corresponding log line occurred.
 */

export type StageKind = "opening" | "endless" | "event_fight" | "campaign" | "unknown";

export interface Stage {
  raw: string;
  difficulty: number | null;
  floor: number | null;
  variant: number | null;
  kind: StageKind;
  /** endless only: which endless map (1-3) */
  endless_map?: number;
  /** event_fight only: encounter pool index */
  pool?: number;
}

/** The battle config JSON the game logs verbatim (LogBattle). Kept untyped-ish:
 *  we pass it through; downstream code picks fields defensively. */
export interface BattleConfig {
  Seed?: number;
  BoardWidth?: number;
  BoardHeight?: number;
  IsBossFloor?: boolean;
  CurrentPlayerShards?: number;
  HeroDtos?: HeroDto[];
  ReserveHeroDtos?: HeroDto[];
  ActiveRelics?: RelicDto[];
  GlobalPermanentCustomData?: Record<string, string>;
  [k: string]: unknown;
}

export interface HeroDto {
  EntityId?: string;
  Rank?: number;
  CharacterRef?: string;
  AppliedRankModifiers?: Record<string, string>;
  ActiveAbility?: { Id?: string };
  HeroClasses?: { Id: string }[];
  EquippedItems?: ({ Id?: { Guid?: string }; ItemRef?: string } | null)[];
  EquippedItemLimit?: number;
  [k: string]: unknown;
}

export interface RelicDto {
  Id?: { Guid?: string };
  EntryRef?: string;
  PermanentCustomData?: Record<string, string>;
  [k: string]: unknown;
}

export interface Death {
  name: string;
  ts: string;
}

export interface Battle {
  stage: Stage | null;
  start_ts: string;
  sim_seed: number | null;
  deaths: Death[];
  outcome: "victory" | "defeat" | null;
  enemy_positions: [number, number][];
  hero_positions: { guid: string; pos: [number, number] }[];
  swaps: number;
  config: BattleConfig | null;
  battle_kind: string | null;
  sim_start_ts?: string;
  combat_s?: number | null;
  planning_s?: number | null;
}

export interface ShopSale {
  kind: "hero" | "item" | "relic";
  name: string;
  index: number;
}

export interface ShopClosed {
  heroes_bought: number;
  heroes_offered_unbought: number;
  heroes_sold: number;
  items_bought: number;
  items_offered_unbought: number;
  items_sold: number;
  relics_bought: number;
  relics_offered_unbought: number;
}

export interface Shop {
  ts: string;
  odds: Record<string, Record<string, number>>;
  sales: ShopSale[];
  after_floor: number | null;
  closed?: ShopClosed;
}

export interface Run {
  start_ts: string;
  log_file: string;
  seed: number | null;
  difficulty: number | null;
  battles: Battle[];
  shops: Shop[];
  crossroads: { text: string; index: number; ts: string }[];
  events: { name: string; ts: string }[];
  relics_granted: { name: string; guid: string; ts: string }[];
  heroes_created: { name: string; guid: string; ts: string }[];
  rank_ups: { name: string; to_rank: string; ts: string }[];
  lives_lost: number;
  endless_maps: number | null;
  act_boss_relics: { stage: Stage | null; relic_ref: string }[];
  resumed?: boolean;
  item_cost_deltas?: number[];
  shard_interest?: number[];
  died_without_stabilizer?: boolean;
  end_ts?: string | null;
  end_reason?: string | null;
  battles_won?: number;
  battles_lost?: number;
  floors_reached?: number;
  beaten?: boolean;
  endless_battles?: number;
  event_fights?: number;
}

export interface Session {
  start_ts: string;
  log_file: string;
  runs: number;
  progression_at_launch?: {
    total_started_runs: number;
    runs_beaten: number;
    highest_difficulty_beaten: number;
    tutorial_steps_done: number;
  };
}

export interface LogRecord {
  ts: string;
  level: string;
  src: string;
  method: string | null;
  srcline: string | null;
  msg: string;
  file: string;
}

export interface ParseResult {
  runs: Run[];
  sessions: Session[];
  recordCount: number;
}
