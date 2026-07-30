/**
 * Run-save capture ingestion.
 *
 * The companion archives each distinct state of the game's in-progress Run
 * save (deleted by the game at run end) and uploads the archive here. Each
 * capture is an envelope {Version, ScopeIndex, DifficultyIndex,
 * IsChallengeModeEnabled, Payload} whose Payload is NESTED MessagePack holding
 * the full run state (ShopDto with the complete priced inventory, EventDto
 * with outcomes, DifficultyDto with the true selected difficulty...).
 *
 * Raw JSON goes to R2 (captures/<sha256>) so facts can always be re-derived;
 * D1 gets the derived rows. Idempotent by content hash.
 */

import { decode } from "@msgpack/msgpack";
import { type Env, sha256Hex } from "./env.js";

/** 1-based per validated play session: index 6 == SSS while the player was on
 * SSS, and Profile's HighestDifficultyBeaten=6 matches "beat SSS, unlocked
 * the challenge format". The '<*>' format is the challenge FLAG, not index 7. */
export const DIFFICULTY_LABELS: Record<number, string> = {
  1: "C", 2: "B", 3: "A", 4: "S", 5: "SS", 6: "SSS",
};

export function difficultyLabel(index: number | null, isChallenge: number | null): string | null {
  if (isChallenge) return "<*>";
  if (index === null || index === undefined) return null;
  return DIFFICULTY_LABELS[index] ?? `#${index}`;
}

interface Envelope {
  Version?: number;
  DifficultyIndex?: number;
  IsChallengeModeEnabled?: boolean;
  Payload?: { type: string; data: number[] };
}

interface ShopEntry {
  HeroSeqId?: number; ItemSeqId?: number; RelicSeqId?: number;
  Rank?: number; BaseCost?: number; DiscountRaw?: number | null;
}

interface Inner {
  RunSessionDto?: { RunId?: string; RunSeed?: number; CurrentTotalFloor?: number };
  PlayerDataDto?: { CurrentShards?: number };
  DifficultyDto?: { SelectedDifficultyIndex?: number };
  ShopDto?: {
    HeroesForSale?: ShopEntry[]; ItemsForSale?: ShopEntry[]; RelicsForSale?: ShopEntry[];
    FrozenHeroesForSale?: ShopEntry[]; FrozenItemsForSale?: ShopEntry[]; FrozenRelicsForSale?: ShopEntry[];
  };
  EventDto?: {
    ActiveEvent?: {
      EventSeqId?: number; Seed?: number; Resolved?: boolean;
      Outcome?: string | null; OutcomeSummaries?: unknown[];
    } | null;
  };
}

export interface CaptureIngestResult {
  received: number;
  ingested: number;
  duplicates: number;
  failed: number;
  runs_updated: number;
}

const offerRows = (
  db: D1Database, hash: string, kind: string, entries: ShopEntry[], frozen: number,
): D1PreparedStatement[] =>
  entries.map((e, slot) => {
    const ref =
      kind === "hero" ? `Hero_${e.HeroSeqId}` :
      kind === "item" ? `Item_${e.ItemSeqId}` : `Relic_${e.RelicSeqId}`;
    return db.prepare(
      `INSERT OR IGNORE INTO capture_shop_offer
         (capture_hash, slot, kind, ref, rank, base_cost, discount_raw, frozen)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind(hash, slot, kind, ref, e.Rank ?? null, e.BaseCost ?? null, e.DiscountRaw ?? null, frozen);
  });

export async function ingestCaptures(
  env: Env,
  playerId: string | null,
  files: { name: string; text: string }[],
): Promise<CaptureIngestResult> {
  const result: CaptureIngestResult = {
    received: files.length, ingested: 0, duplicates: 0, failed: 0, runs_updated: 0,
  };
  const now = new Date().toISOString();
  const runsSeen = new Map<number, { difficultyIndex: number | null; isChallenge: number; runGuid: string | null }>();

  for (const f of files) {
    try {
      const hash = await sha256Hex(f.text);
      const dup = await env.DB
        .prepare("SELECT hash FROM capture WHERE hash = ?").bind(hash).first();
      if (dup) { result.duplicates++; continue; }

      const envParsed = JSON.parse(f.text) as Envelope;
      const payload = envParsed.Payload?.data;
      if (!payload) { result.failed++; continue; }
      const inner = decode(new Uint8Array(payload)) as Inner;

      const shop = inner.ShopDto ?? {};
      const open =
        (shop.HeroesForSale?.length ?? 0) + (shop.ItemsForSale?.length ?? 0) +
        (shop.RelicsForSale?.length ?? 0) > 0;
      const difficultyIndex = inner.DifficultyDto?.SelectedDifficultyIndex ?? null;
      const isChallenge = envParsed.IsChallengeModeEnabled ? 1 : 0;
      const runSeed = inner.RunSessionDto?.RunSeed ?? null;
      const runGuid = inner.RunSessionDto?.RunId ?? null;

      // archive filename carries the companion's capture timestamp:
      // 2026-07-30T17-49-45-998Z-<hash>.json
      const tsMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(f.name);
      const capturedAt = tsMatch
        ? `${tsMatch[1]}T${tsMatch[2]}:${tsMatch[3]}:${tsMatch[4]}Z` : null;

      await env.RAW_R2.put(`captures/${hash}`, f.text);

      const stmts: D1PreparedStatement[] = [
        env.DB.prepare(
          `INSERT OR IGNORE INTO capture
             (hash, player_id, run_seed, run_guid, captured_at, total_floor, shards,
              difficulty_index, is_challenge, shop_open, received_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          hash, playerId, runSeed, runGuid, capturedAt,
          inner.RunSessionDto?.CurrentTotalFloor ?? null,
          inner.PlayerDataDto?.CurrentShards ?? null,
          difficultyIndex, isChallenge, open ? 1 : 0, now,
        ),
        ...offerRows(env.DB, hash, "hero", shop.HeroesForSale ?? [], 0),
        ...offerRows(env.DB, hash, "item", shop.ItemsForSale ?? [], 0),
        ...offerRows(env.DB, hash, "relic", shop.RelicsForSale ?? [], 0),
        ...offerRows(env.DB, hash, "hero", shop.FrozenHeroesForSale ?? [], 1),
        ...offerRows(env.DB, hash, "item", shop.FrozenItemsForSale ?? [], 1),
        ...offerRows(env.DB, hash, "relic", shop.FrozenRelicsForSale ?? [], 1),
      ];
      const ev = inner.EventDto?.ActiveEvent;
      if (ev?.EventSeqId !== undefined) {
        stmts.push(
          env.DB.prepare(
            `INSERT OR REPLACE INTO capture_event
               (capture_hash, event_seq, event_seed, resolved, outcome_text, summaries)
             VALUES (?,?,?,?,?,?)`,
          ).bind(
            hash, ev.EventSeqId, ev.Seed ?? null, ev.Resolved ? 1 : 0,
            ev.Outcome ?? null,
            ev.OutcomeSummaries?.length ? JSON.stringify(ev.OutcomeSummaries) : null,
          ),
        );
      }
      for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
      result.ingested++;

      if (runSeed !== null) {
        runsSeen.set(runSeed, { difficultyIndex, isChallenge, runGuid });
      }
    } catch {
      result.failed++;
    }
  }

  // backfill true difficulty onto the matching runs (logs never carry it)
  for (const [seed, info] of runsSeen) {
    const res = await env.DB
      .prepare(
        `UPDATE run SET difficulty_index = ?, is_challenge = ?, run_guid = COALESCE(run_guid, ?)
         WHERE player_id IS ? AND seed = ?`,
      )
      .bind(info.difficultyIndex, info.isChallenge, info.runGuid, playerId, seed)
      .run();
    if (res.meta.changes) result.runs_updated++;
  }
  return result;
}
