/**
 * Facts layer: turn parsed runs into normalized D1 rows.
 *
 * Dedupe policy (runs can arrive twice — re-uploads, or a partial run in
 * yesterday's upload completed by today's): the identity of a run is
 * (player_id, seed, start_date). If an incoming run matches an existing one,
 * it replaces it only when it contains MORE battles; otherwise it is skipped.
 * All child rows hang off run/battle ids, so replacement is a targeted delete.
 */

import {
  parseGuildrunLogs, snapshotBattle, diffSnapshots,
  type LogFile, type Run, type Battle,
} from "@guildrun/parser";

export interface InsertSummary {
  runsFound: number;
  runsInserted: number;
  runsReplaced: number;
  runsSkipped: number;
}

export function parseFiles(files: LogFile[]): Run[] {
  return parseGuildrunLogs(files).runs;
}

/** hero display name -> Hero_N ref, for resolving death names */
export async function heroNameMap(db: D1Database): Promise<Map<string, string>> {
  const rows = await db
    .prepare("SELECT ref, name FROM catalog WHERE entity_type = 'hero'")
    .all<{ ref: string; name: string }>();
  return new Map(rows.results.map((r) => [r.name, r.ref]));
}

const chunk = <T,>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

async function deleteRunDeep(db: D1Database, runId: number): Promise<void> {
  await db.batch([
    db.prepare(
      "DELETE FROM battle_unit WHERE battle_id IN (SELECT id FROM battle WHERE run_id = ?)",
    ).bind(runId),
    db.prepare(
      "DELETE FROM battle_unit_item WHERE battle_id IN (SELECT id FROM battle WHERE run_id = ?)",
    ).bind(runId),
    db.prepare(
      "DELETE FROM battle_relic WHERE battle_id IN (SELECT id FROM battle WHERE run_id = ?)",
    ).bind(runId),
    db.prepare(
      "DELETE FROM battle_death WHERE battle_id IN (SELECT id FROM battle WHERE run_id = ?)",
    ).bind(runId),
    db.prepare("DELETE FROM battle WHERE run_id = ?").bind(runId),
    db.prepare("DELETE FROM acquisition WHERE run_id = ?").bind(runId),
    db.prepare("DELETE FROM shop_phase WHERE run_id = ?").bind(runId),
    db.prepare("DELETE FROM run WHERE id = ?").bind(runId),
  ]);
}

/** Remove all facts previously derived from an upload (for reparse). */
export async function deleteFactsForUpload(db: D1Database, uploadId: string): Promise<number> {
  const runs = await db
    .prepare("SELECT id FROM run WHERE upload_id = ?")
    .bind(uploadId)
    .all<{ id: number }>();
  for (const r of runs.results) await deleteRunDeep(db, r.id);
  return runs.results.length;
}

export async function insertFacts(
  db: D1Database,
  uploadId: string,
  playerId: string | null,
  gameVersionId: number,
  runs: Run[],
  heroNames: Map<string, string>,
): Promise<InsertSummary> {
  const summary: InsertSummary = {
    runsFound: runs.length, runsInserted: 0, runsReplaced: 0, runsSkipped: 0,
  };

  for (const run of runs) {
    const startDate = run.start_ts.slice(0, 10);

    const existing = await db
      .prepare(
        `SELECT r.id, (SELECT COUNT(*) FROM battle b WHERE b.run_id = r.id) AS n
         FROM run r WHERE r.player_id IS ? AND r.seed IS ? AND r.start_date = ?`,
      )
      .bind(playerId, run.seed, startDate)
      .first<{ id: number; n: number }>();

    if (existing) {
      if (existing.n >= run.battles.length) {
        summary.runsSkipped += 1;
        continue;
      }
      await deleteRunDeep(db, existing.id);
      summary.runsReplaced += 1;
    }

    const runRow = await db
      .prepare(
        `INSERT INTO run (upload_id, player_id, seed, start_ts, start_date, difficulty,
           floors_reached, beaten, battles_won, battles_lost, lives_lost,
           endless_battles, event_fights, game_version_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .bind(
        uploadId, playerId, run.seed, run.start_ts, startDate, run.difficulty,
        run.floors_reached ?? 0, run.beaten ? 1 : 0, run.battles_won ?? 0,
        run.battles_lost ?? 0, run.lives_lost, run.endless_battles ?? 0,
        run.event_fights ?? 0, gameVersionId,
      )
      .first<{ id: number }>();
    const runId = runRow!.id;
    summary.runsInserted += 1;

    // battles (RETURNING id, chunked batches preserve order)
    const battleStmts = run.battles.map((b, i) =>
      db.prepare(
        `INSERT INTO battle (run_id, ordinal, stage_raw, stage_kind, floor, variant,
           sim_seed, outcome, is_boss, party_size, enemy_count, planning_s, combat_s)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      ).bind(
        runId, i, b.stage?.raw ?? null, b.stage?.kind ?? null, b.stage?.floor ?? null,
        b.stage?.variant ?? null, b.sim_seed, b.outcome,
        b.config?.IsBossFloor ? 1 : 0, b.config?.HeroDtos?.length ?? null,
        b.enemy_positions.length, b.planning_s ?? null, b.combat_s ?? null,
      ),
    );
    const battleIds: number[] = [];
    for (const group of chunk(battleStmts, 40)) {
      const res = await db.batch<{ id: number }>(group);
      for (const r of res) battleIds.push(r.results[0]!.id);
    }

    // children
    const children: D1PreparedStatement[] = [];
    run.battles.forEach((b, i) => {
      const bid = battleIds[i]!;
      children.push(...battleChildStmts(db, bid, b, heroNames));
    });
    children.push(...phaseStmts(db, runId, run));
    for (const group of chunk(children, 40)) {
      if (group.length) await db.batch(group);
    }
  }

  if (playerId) {
    await db
      .prepare(
        `UPDATE player SET run_count =
           (SELECT COUNT(*) FROM run WHERE player_id = ?) WHERE id = ?`,
      )
      .bind(playerId, playerId)
      .run();
  }
  return summary;
}

const stripSeq = (s: string | undefined): string => (s ?? "").replace("seq:", "");

/** Logs write item refs as `tem_311` (the sheet's own prefix quirk); the
 * catalog — and therefore every stats join — uses `Item_311`. Facts store the
 * canonical form. */
const normItem = (ref: string): string => ref.replace(/^tem_/, "Item_");

function battleChildStmts(
  db: D1Database,
  battleId: number,
  b: Battle,
  heroNames: Map<string, string>,
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  const cfg = b.config;
  if (cfg) {
    const reserve = cfg.ReserveHeroDtos ?? [];
    for (const h of [...(cfg.HeroDtos ?? []), ...reserve]) {
      if (!h.EntityId) continue;
      stmts.push(
        db.prepare(
          "INSERT OR IGNORE INTO battle_unit (battle_id, guid, hero_ref, rank, reserve) VALUES (?,?,?,?,?)",
        ).bind(battleId, h.EntityId, stripSeq(h.CharacterRef), h.Rank ?? null,
          reserve.includes(h) ? 1 : 0),
      );
      const counts = new Map<string, number>();
      for (const it of h.EquippedItems ?? []) {
        if (!it) continue;
        const ref = normItem(stripSeq(it.ItemRef));
        counts.set(ref, (counts.get(ref) ?? 0) + 1);
      }
      for (const [ref, n] of counts) {
        stmts.push(
          db.prepare(
            "INSERT OR IGNORE INTO battle_unit_item (battle_id, guid, item_ref, n) VALUES (?,?,?,?)",
          ).bind(battleId, h.EntityId, ref, n),
        );
      }
    }
    for (const r of cfg.ActiveRelics ?? []) {
      const guid = r.Id?.Guid;
      if (!guid) continue;
      stmts.push(
        db.prepare(
          "INSERT OR IGNORE INTO battle_relic (battle_id, guid, relic_ref) VALUES (?,?,?)",
        ).bind(battleId, guid, stripSeq(r.EntryRef)),
      );
    }
  }
  b.deaths.forEach((d, seq) => {
    stmts.push(
      db.prepare(
        "INSERT OR IGNORE INTO battle_death (battle_id, seq, name, hero_ref) VALUES (?,?,?,?)",
      ).bind(battleId, seq, d.name, heroNames.get(d.name) ?? null),
    );
  });
  return stmts;
}

/** Shop phases + acquisitions: diff consecutive battle configs, and align the
 * shop-closed analytics lines (by timestamp window) to the same phase. */
function phaseStmts(db: D1Database, runId: number, run: Run): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  let prevSnap = null as ReturnType<typeof snapshotBattle>;
  let prevTs: string | null = null;
  let prevOrdinal = -1;

  run.battles.forEach((b, ordinal) => {
    const snap = snapshotBattle(b.config);
    if (snap && prevSnap) {
      const d = diffSnapshots(prevSnap, snap);
      let seq = 0;
      const push = (kind: string, ref: string, heroRef: string | null, detail: unknown): void => {
        stmts.push(
          db.prepare(
            "INSERT OR IGNORE INTO acquisition (run_id, after_ordinal, seq, kind, ref, hero_ref, detail) VALUES (?,?,?,?,?,?,?)",
          ).bind(runId, prevOrdinal, seq++, kind, ref, heroRef,
            detail == null ? null : JSON.stringify(detail)),
        );
      };
      for (const h of d.joined) push("hero_join", h.ref, null, { rank: h.rank });
      for (const h of d.left) push("hero_leave", h.ref, null, null);
      for (const r of d.ranked) push("rank_up", r.ref, null, { from: r.from, to: r.to });
      for (const s of d.specialised) push("spec_gain", s.ref, null, { classes: s.gained });
      for (const e of d.equipped) push("item_equip", normItem(e.itemRef), e.heroRef, null);
      for (const e of d.unequipped) push("item_unequip", normItem(e.itemRef), e.heroRef, null);
      for (const r of d.relics_gained) push("relic_gain", r, null, null);
      for (const r of d.relics_lost) push("relic_lost", r, null, null);

      const shopsInWindow = run.shops.filter(
        (s) => prevTs !== null && s.ts > prevTs && s.ts < b.start_ts,
      );
      shopsInWindow.forEach((s, sSeq) => {
        const c = s.closed;
        stmts.push(
          db.prepare(
            `INSERT OR IGNORE INTO shop_phase (run_id, after_ordinal, seq,
               heroes_bought, heroes_offered, heroes_sold,
               items_bought, items_offered, items_sold,
               relics_bought, relics_offered, rerolls, net_shards, sales_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).bind(
            runId, prevOrdinal, sSeq,
            c ? c.heroes_bought : null,
            c ? c.heroes_bought + c.heroes_offered_unbought : null,
            c ? c.heroes_sold : null,
            c ? c.items_bought : null,
            c ? c.items_bought + c.items_offered_unbought : null,
            c ? c.items_sold : null,
            c ? c.relics_bought : null,
            c ? c.relics_bought + c.relics_offered_unbought : null,
            sSeq === shopsInWindow.length - 1 ? d.rerolls : null,
            sSeq === shopsInWindow.length - 1 ? d.net_shards_spent : null,
            JSON.stringify(s.sales),
          ),
        );
      });
    }
    if (snap) {
      prevSnap = snap;
      prevTs = b.start_ts;
      prevOrdinal = ordinal;
    }
  });
  return stmts;
}
