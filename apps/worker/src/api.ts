/**
 * Read API — the stable contract the stats site consumes today and a future
 * companion app consumes later. All responses are JSON; contexts are addressed
 * by ?version= & ?difficulty= & ?floor_band= with 'all'/0 sentinels.
 */

import { Hono } from "hono";
import type { Env } from "./env.js";

type App = { Bindings: Env };

const ENTITY_TYPES = new Set(["hero", "item", "relic"]);
const PLURALS: Record<string, string> = { heroes: "hero", items: "item", relics: "relic" };
const CACHE = "public, max-age=300";

export const api = new Hono<App>();

api.get("/overview", async (c) => {
  const db = c.env.DB;
  const totals = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM run) runs,
              (SELECT COUNT(*) FROM run WHERE beaten = 1) beaten,
              (SELECT COUNT(*) FROM battle) battles,
              (SELECT COUNT(*) FROM player) players,
              (SELECT COUNT(*) FROM upload WHERE status = 'parsed') uploads,
              (SELECT MAX(computed_at) FROM stat) stats_computed_at`,
    )
    .first();
  return c.json(totals, 200, { "Cache-Control": CACHE });
});

api.get("/catalog", async (c) => {
  const rows = await c.env.DB
    .prepare("SELECT entity_type, ref, name, rarity, meta FROM catalog")
    .all<{ entity_type: string; ref: string; name: string; rarity: string | null; meta: string | null }>();
  const out: Record<string, Record<string, unknown>> = {};
  for (const r of rows.results) {
    (out[r.entity_type] ??= {})[r.ref] = {
      name: r.name,
      rarity: r.rarity,
      ...(r.meta ? { meta: JSON.parse(r.meta) as unknown } : {}),
    };
  }
  return c.json(out, 200, { "Cache-Control": "public, max-age=3600" });
});

function ctxParams(c: { req: { query: (k: string) => string | undefined } }): {
  version: string; difficulty: number; band: string;
} {
  return {
    version: c.req.query("version") ?? "all",
    difficulty: parseInt(c.req.query("difficulty") ?? "0", 10),
    band: c.req.query("floor_band") ?? "all",
  };
}

api.get("/stats/:type", async (c) => {
  const raw = c.req.param("type");
  const type = PLURALS[raw] ?? raw;
  if (!ENTITY_TYPES.has(type)) return c.json({ error: "unknown entity type" }, 404);
  const { version, difficulty, band } = ctxParams(c);
  const rows = await c.env.DB
    .prepare(
      `SELECT s.ref, cat.name, cat.rarity, s.n_battles, s.battle_wins, s.n_runs, s.run_beats,
              s.deaths, s.battle_score, s.run_score, s.battle_lift, s.run_lift, s.tier
       FROM stat s
       LEFT JOIN catalog cat ON cat.entity_type = s.entity_type AND cat.ref = s.ref
       WHERE s.entity_type = ? AND s.ctx_version = ? AND s.ctx_difficulty = ? AND s.ctx_floor_band = ?
       ORDER BY CASE s.tier WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 WHEN 'D' THEN 4 ELSE 5 END,
                COALESCE(s.run_lift, s.battle_lift) DESC`,
    )
    .bind(type, version, difficulty, band)
    .all();
  return c.json(
    { context: { version, difficulty, floor_band: band }, entities: rows.results },
    200, { "Cache-Control": CACHE },
  );
});

/** Compact hot path for the future companion app: ref -> {tier, lift, n}. */
api.get("/tiers", async (c) => {
  const { version, difficulty, band } = ctxParams(c);
  const rows = await c.env.DB
    .prepare(
      `SELECT entity_type, ref, tier, COALESCE(run_lift, battle_lift) lift,
              n_battles, n_runs
       FROM stat WHERE ctx_version = ? AND ctx_difficulty = ? AND ctx_floor_band = ? AND tier IS NOT NULL`,
    )
    .bind(version, difficulty, band)
    .all<{ entity_type: string; ref: string; tier: string; lift: number; n_battles: number; n_runs: number }>();
  const out: Record<string, Record<string, unknown>> = {};
  for (const r of rows.results) {
    (out[r.entity_type] ??= {})[r.ref] = {
      tier: r.tier, lift: r.lift, n_battles: r.n_battles, n_runs: r.n_runs,
    };
  }
  return c.json(
    { context: { version, difficulty, floor_band: band }, tiers: out },
    200, { "Cache-Control": CACHE },
  );
});

api.get("/entity/:type/:ref", async (c) => {
  const type = c.req.param("type");
  const ref = c.req.param("ref");
  if (!ENTITY_TYPES.has(type)) return c.json({ error: "unknown entity type" }, 404);
  const cat = await c.env.DB
    .prepare("SELECT name, rarity, meta FROM catalog WHERE entity_type = ? AND ref = ?")
    .bind(type, ref)
    .first<{ name: string; rarity: string | null; meta: string | null }>();
  const contexts = await c.env.DB
    .prepare(
      `SELECT ctx_version, ctx_difficulty, ctx_floor_band, n_battles, battle_wins,
              n_runs, run_beats, deaths, battle_score, run_score, battle_lift, run_lift, tier
       FROM stat WHERE entity_type = ? AND ref = ?
       ORDER BY ctx_version, ctx_difficulty, ctx_floor_band`,
    )
    .bind(type, ref)
    .all();
  if (!cat && !contexts.results.length) return c.json({ error: "not found" }, 404);
  return c.json(
    {
      ref,
      name: cat?.name ?? ref,
      rarity: cat?.rarity ?? null,
      meta: cat?.meta ? (JSON.parse(cat.meta) as unknown) : null,
      contexts: contexts.results,
    },
    200, { "Cache-Control": CACHE },
  );
});

api.get("/runs", async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT id, seed, start_ts, difficulty, floors_reached, beaten,
              battles_won, battles_lost, endless_battles
       FROM run ORDER BY start_ts DESC LIMIT 100`,
    )
    .all();
  return c.json({ runs: rows.results }, 200, { "Cache-Control": CACHE });
});

/** Full replay of one run, names resolved — powers the /runs/:id page. */
api.get("/runs/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const db = c.env.DB;
  const run = await db.prepare("SELECT * FROM run WHERE id = ?").bind(id).first();
  if (!run) return c.json({ error: "not found" }, 404);

  const [battles, units, items, relics, deaths, acqs, shops, catalog] = await Promise.all([
    db.prepare("SELECT * FROM battle WHERE run_id = ? ORDER BY ordinal").bind(id).all(),
    db.prepare(
      "SELECT bu.* FROM battle_unit bu JOIN battle b ON b.id = bu.battle_id WHERE b.run_id = ?",
    ).bind(id).all<{ battle_id: number; guid: string; hero_ref: string; rank: number | null; reserve: number }>(),
    db.prepare(
      "SELECT bi.* FROM battle_unit_item bi JOIN battle b ON b.id = bi.battle_id WHERE b.run_id = ?",
    ).bind(id).all<{ battle_id: number; guid: string; item_ref: string; n: number }>(),
    db.prepare(
      "SELECT br.* FROM battle_relic br JOIN battle b ON b.id = br.battle_id WHERE b.run_id = ?",
    ).bind(id).all<{ battle_id: number; guid: string; relic_ref: string }>(),
    db.prepare(
      "SELECT bd.* FROM battle_death bd JOIN battle b ON b.id = bd.battle_id WHERE b.run_id = ? ORDER BY bd.seq",
    ).bind(id).all<{ battle_id: number; seq: number; name: string; hero_ref: string | null }>(),
    db.prepare("SELECT * FROM acquisition WHERE run_id = ? ORDER BY after_ordinal, seq").bind(id).all(),
    db.prepare("SELECT * FROM shop_phase WHERE run_id = ? ORDER BY after_ordinal, seq").bind(id).all(),
    db.prepare("SELECT entity_type, ref, name, rarity FROM catalog").all<{
      entity_type: string; ref: string; name: string; rarity: string | null;
    }>(),
  ]);

  const names = new Map(catalog.results.map((r) => [`${r.entity_type}:${r.ref}`, r.name]));
  const rarities = new Map(catalog.results.map((r) => [`${r.entity_type}:${r.ref}`, r.rarity]));
  const resolve = (t: string, ref: string): { ref: string; name: string; rarity: string | null } => ({
    ref,
    // item refs appear log-native as tem_N; the catalog stores Item_N
    name: names.get(`${t}:${ref}`) ?? names.get(`${t}:${ref.replace(/^tem_/, "Item_")}`) ?? ref,
    rarity: rarities.get(`${t}:${ref}`) ?? rarities.get(`${t}:${ref.replace(/^tem_/, "Item_")}`) ?? null,
  });

  const byBattle = <T extends { battle_id: number }>(rows: T[]): Map<number, T[]> => {
    const m = new Map<number, T[]>();
    for (const r of rows) {
      const arr = m.get(r.battle_id) ?? [];
      arr.push(r);
      m.set(r.battle_id, arr);
    }
    return m;
  };
  const unitsBy = byBattle(units.results);
  const itemsBy = byBattle(items.results);
  const relicsBy = byBattle(relics.results);
  const deathsBy = byBattle(deaths.results);

  const battlesOut = battles.results.map((b) => {
    const bid = (b as { id: number }).id;
    const unitItems = new Map<string, { item_ref: string; n: number }[]>();
    for (const it of itemsBy.get(bid) ?? []) {
      const arr = unitItems.get(it.guid) ?? [];
      arr.push({ item_ref: it.item_ref, n: it.n });
      unitItems.set(it.guid, arr);
    }
    return {
      ...b,
      party: (unitsBy.get(bid) ?? []).map((u) => ({
        ...resolve("hero", u.hero_ref),
        rank: u.rank,
        reserve: !!u.reserve,
        items: (unitItems.get(u.guid) ?? []).flatMap((it) =>
          Array(it.n).fill(resolve("item", it.item_ref)) as ReturnType<typeof resolve>[],
        ),
      })),
      relics: (relicsBy.get(bid) ?? []).map((r) => resolve("relic", r.relic_ref)),
      deaths: (deathsBy.get(bid) ?? []).map((d) => ({
        name: d.name, is_hero: d.hero_ref !== null,
      })),
    };
  });

  const acqsOut = (acqs.results as { kind: string; ref: string; hero_ref: string | null }[]).map((a) => ({
    ...a,
    resolved:
      a.kind.startsWith("item") ? resolve("item", a.ref)
      : a.kind.startsWith("relic") ? resolve("relic", a.ref)
      : resolve("hero", a.ref),
    hero: a.hero_ref ? resolve("hero", a.hero_ref) : null,
  }));

  return c.json(
    { run, battles: battlesOut, acquisitions: acqsOut, shop_phases: shops.results },
    200, { "Cache-Control": CACHE },
  );
});
