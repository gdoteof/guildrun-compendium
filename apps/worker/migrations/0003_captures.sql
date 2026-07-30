-- Run-save captures: the companion archives every distinct state of the
-- in-progress Run save (which the game deletes at run end) and uploads them.
-- Raw JSON lives in R2 (captures/<sha256>), these are the derived facts.
--
-- Shop offers are the headline: the save names the FULL live inventory with
-- prices — including offers rerolled past — which no log line ever does.

CREATE TABLE capture (
  hash        TEXT PRIMARY KEY,          -- sha256 of raw capture JSON (R2 key)
  player_id   TEXT,
  run_seed    INTEGER,                   -- RunSessionDto.RunSeed; joins run.seed
  run_guid    TEXT,                      -- RunSessionDto.RunId
  captured_at TEXT,                      -- from the companion's archive filename
  total_floor INTEGER,
  shards      INTEGER,
  difficulty_index INTEGER,              -- DifficultyDto.SelectedDifficultyIndex (1=C..6=SSS)
  is_challenge INTEGER,                  -- envelope IsChallengeModeEnabled ('<*>' format)
  shop_open   INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL
);
CREATE INDEX idx_capture_run ON capture(player_id, run_seed);

CREATE TABLE capture_shop_offer (
  capture_hash TEXT NOT NULL,
  slot         INTEGER NOT NULL,
  kind         TEXT NOT NULL,            -- hero|item|relic
  ref          TEXT NOT NULL,            -- Hero_N|Item_N|Relic_N
  rank         INTEGER,                  -- heroes: 1=C 2=B 3=A 4=S
  base_cost    INTEGER,
  discount_raw INTEGER,                  -- Q16 fraction; 16384 = 25% off
  frozen       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (capture_hash, kind, slot, frozen)
);
CREATE INDEX idx_offer_ref ON capture_shop_offer(kind, ref);

CREATE TABLE capture_event (
  capture_hash TEXT NOT NULL,
  event_seq    INTEGER NOT NULL,
  event_seed   INTEGER,
  resolved     INTEGER NOT NULL,
  outcome_text TEXT,
  summaries    TEXT,                     -- JSON OutcomeSummaries (names granted elements)
  PRIMARY KEY (capture_hash, event_seq)
);

-- True difficulty on runs, filled from captures when available. The existing
-- run.difficulty column is the STAGE POOL (1-3, from stage ids) — a related
-- but different axis; the selected difficulty (C..SSS, and the '<*>'
-- challenge format) was never in the logs at all.
ALTER TABLE run ADD COLUMN difficulty_index INTEGER;
ALTER TABLE run ADD COLUMN is_challenge INTEGER;
ALTER TABLE run ADD COLUMN run_guid TEXT;
