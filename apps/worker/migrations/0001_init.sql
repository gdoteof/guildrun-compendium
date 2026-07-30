-- Guildrun Compendium — facts + aggregates schema.
--
-- Three layers: raw logs live in object storage (KV now, R2 later); this file
-- defines the FACTS (rebuildable from raw by re-parsing) and the AGGREGATES
-- (rebuildable from facts by the materializer). Facts rows all trace back to
-- an upload_id so a reparse can delete-and-reinsert idempotently.

-- ---------------------------------------------------------------- reference

CREATE TABLE game_version (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  build_guid  TEXT UNIQUE,
  label       TEXT NOT NULL,
  first_seen  TEXT NOT NULL
);

-- Content catalog (names/rarities extracted from game assets by us, seeded via
-- admin endpoint; refs are log-native: Hero_13, Item_311, Relic_723).
CREATE TABLE catalog (
  entity_type     TEXT NOT NULL,          -- hero|item|relic|enemy|hero_class|...
  ref             TEXT NOT NULL,
  game_version_id INTEGER NOT NULL DEFAULT 0,   -- 0 = applies to all versions
  name            TEXT NOT NULL,
  rarity          TEXT,
  meta            TEXT,                   -- JSON: classes, pools, description...
  PRIMARY KEY (entity_type, ref, game_version_id)
);

-- ---------------------------------------------------------------- ingest

CREATE TABLE player (
  id         TEXT PRIMARY KEY,            -- HMAC-SHA256(server salt, SteamID64)
  first_seen TEXT NOT NULL,
  run_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE upload (
  id             TEXT PRIMARY KEY,        -- uuid
  content_hash   TEXT NOT NULL UNIQUE,    -- sha256 over the sorted scrubbed file hashes
  player_id      TEXT,
  received_at    TEXT NOT NULL,
  build_guid     TEXT,
  parser_version TEXT,
  status         TEXT NOT NULL DEFAULT 'received',  -- received|parsed|failed
  file_count     INTEGER,
  runs_found     INTEGER,
  runs_inserted  INTEGER,
  error          TEXT
);

-- One row per distinct file; raw storage key = file_hash (content-addressed,
-- so the same file uploaded twice is stored once).
CREATE TABLE upload_file (
  upload_id  TEXT NOT NULL,
  file_hash  TEXT NOT NULL,
  name       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  PRIMARY KEY (upload_id, file_hash)
);

-- ---------------------------------------------------------------- facts

CREATE TABLE run (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id       TEXT NOT NULL,
  player_id       TEXT,
  seed            INTEGER,
  start_ts        TEXT NOT NULL,
  start_date      TEXT NOT NULL,          -- date(start_ts), part of the dedupe key
  difficulty      INTEGER,
  floors_reached  INTEGER,
  beaten          INTEGER NOT NULL DEFAULT 0,
  battles_won     INTEGER,
  battles_lost    INTEGER,
  lives_lost      INTEGER,
  endless_battles INTEGER,
  event_fights    INTEGER,
  game_version_id INTEGER NOT NULL DEFAULT 0,
  -- same player + same run seed + same day = same run, regardless of which
  -- upload (or log-file rotation) it arrived in
  UNIQUE (player_id, seed, start_date)
);
CREATE INDEX idx_run_upload ON run(upload_id);

CREATE TABLE battle (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL,
  ordinal     INTEGER NOT NULL,           -- 0-based within the run
  stage_raw   TEXT,
  stage_kind  TEXT,                       -- opening|campaign|event_fight|endless
  floor       INTEGER,
  variant     INTEGER,
  sim_seed    INTEGER,
  outcome     TEXT,                       -- victory|defeat|NULL (abandoned)
  is_boss     INTEGER,
  party_size  INTEGER,
  enemy_count INTEGER,
  planning_s  REAL,
  combat_s    REAL,
  UNIQUE (run_id, ordinal)
);

-- One row per fielded/reserve hero instance (EntityId GUID), so duplicate
-- copies of the same hero are representable.
CREATE TABLE battle_unit (
  battle_id INTEGER NOT NULL,
  guid      TEXT NOT NULL,
  hero_ref  TEXT NOT NULL,
  rank      INTEGER,
  reserve   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (battle_id, guid)
);
CREATE INDEX idx_unit_ref ON battle_unit(hero_ref);

CREATE TABLE battle_unit_item (
  battle_id INTEGER NOT NULL,
  guid      TEXT NOT NULL,
  item_ref  TEXT NOT NULL,
  n         INTEGER NOT NULL DEFAULT 1,  -- copies of the same item on one unit
  PRIMARY KEY (battle_id, guid, item_ref)
);
CREATE INDEX idx_item_ref ON battle_unit_item(item_ref);

CREATE TABLE battle_relic (
  battle_id INTEGER NOT NULL,
  guid      TEXT NOT NULL,               -- relic instance guid (copies OK)
  relic_ref TEXT NOT NULL,
  PRIMARY KEY (battle_id, guid)
);
CREATE INDEX idx_relic_ref ON battle_relic(relic_ref);

-- Deaths as logged (display names); hero_ref resolved via catalog when possible.
CREATE TABLE battle_death (
  battle_id INTEGER NOT NULL,
  seq       INTEGER NOT NULL,
  name      TEXT NOT NULL,
  hero_ref  TEXT,                        -- NULL for enemies / unresolved
  PRIMARY KEY (battle_id, seq)
);

-- What changed between consecutive battles (= the shop/crossroads phase),
-- reconstructed by diffing battle configs.
CREATE TABLE acquisition (
  run_id        INTEGER NOT NULL,
  after_ordinal INTEGER NOT NULL,        -- ordinal of the battle BEFORE the phase
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL,           -- hero_join|hero_leave|item_equip|item_unequip|relic_gain|relic_lost|rank_up|spec_gain
  ref           TEXT NOT NULL,
  hero_ref      TEXT,                    -- for item_equip/unequip: who got it
  detail        TEXT,                    -- JSON extras (from/to rank, classes...)
  PRIMARY KEY (run_id, after_ordinal, seq)
);

CREATE TABLE shop_phase (
  run_id          INTEGER NOT NULL,
  after_ordinal   INTEGER NOT NULL,
  seq             INTEGER NOT NULL DEFAULT 0,  -- >1 shop per phase is possible
  heroes_bought   INTEGER, heroes_offered INTEGER, heroes_sold INTEGER,
  items_bought    INTEGER, items_offered  INTEGER, items_sold  INTEGER,
  relics_bought   INTEGER, relics_offered INTEGER,
  rerolls         INTEGER,
  net_shards      INTEGER,               -- prev battle shards - next battle shards
  sales_json      TEXT,                  -- named sale offers (the only offers logged by name)
  PRIMARY KEY (run_id, after_ordinal, seq)
);

-- ---------------------------------------------------------------- aggregates

-- Materialized stats. Context sentinels: ctx_difficulty 0 = all difficulties,
-- ctx_floor_band 'all' = all bands, ctx_version 'all' = all versions.
CREATE TABLE stat (
  entity_type    TEXT NOT NULL,
  ref            TEXT NOT NULL,
  ctx_version    TEXT NOT NULL,
  ctx_difficulty INTEGER NOT NULL,
  ctx_floor_band TEXT NOT NULL,          -- '1-4'|'6-9'|'10-13'|'endless'|'all'
  n_battles      INTEGER NOT NULL,
  battle_wins    INTEGER NOT NULL,
  n_runs         INTEGER NOT NULL,
  run_beats      INTEGER NOT NULL,
  deaths         INTEGER NOT NULL DEFAULT 0,
  battle_score   REAL,                   -- shrunk battle-win rate
  run_score      REAL,                   -- shrunk run-beaten rate
  battle_lift    REAL,                   -- battle_score / contextual baseline
  run_lift       REAL,
  tier           TEXT,                   -- S|A|B|C|D
  computed_at    TEXT NOT NULL,
  PRIMARY KEY (entity_type, ref, ctx_version, ctx_difficulty, ctx_floor_band)
);

-- Reserved for composition/synergy stats (populated in a later phase).
CREATE TABLE pair_stat (
  entity_type_a  TEXT NOT NULL, ref_a TEXT NOT NULL,
  entity_type_b  TEXT NOT NULL, ref_b TEXT NOT NULL,
  ctx_version    TEXT NOT NULL,
  ctx_difficulty INTEGER NOT NULL,
  ctx_floor_band TEXT NOT NULL,
  n              INTEGER NOT NULL,
  wins           INTEGER NOT NULL,
  computed_at    TEXT NOT NULL,
  PRIMARY KEY (entity_type_a, ref_a, entity_type_b, ref_b, ctx_version, ctx_difficulty, ctx_floor_band)
);
