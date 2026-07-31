/**
 * Read API — the stable contract the stats site consumes today and a future
 * companion app consumes later. All responses are JSON; contexts are addressed
 * by ?version= & ?difficulty= & ?floor_band= with 'all'/0 sentinels.
 */

import { Hono } from "hono";
import type { Env } from "./env.js";
import { difficultyLabel } from "./captures.js";

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

/** All contributors. Only anonymous hashes until Steam sign-in sets
 * display_name; the short label is what the UI shows. */
api.get("/players", async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT p.id, p.display_name, p.first_seen,
              COUNT(r.id) runs,
              SUM(r.beaten) beaten,
              SUM(r.battles_won) battles_won,
              SUM(r.battles_lost) battles_lost,
              MAX(CASE WHEN r.beaten = 1 THEN r.difficulty END) highest_difficulty_beaten,
              MAX(r.start_ts) last_run_ts
       FROM player p LEFT JOIN run r ON r.player_id = p.id
       GROUP BY p.id ORDER BY runs DESC`,
    )
    .all<{ id: string; display_name: string | null; first_seen: string; runs: number }>();
  return c.json(
    {
      players: rows.results.map((p) => ({
        ...p,
        label: p.display_name ?? `Guest ${p.id.slice(0, 8)}`,
        anonymous: p.display_name === null,
      })),
    },
    200, { "Cache-Control": CACHE },
  );
});

api.get("/players/:id", async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  const player = await db
    .prepare("SELECT id, display_name, first_seen FROM player WHERE id = ?")
    .bind(id)
    .first<{ id: string; display_name: string | null; first_seen: string }>();
  if (!player) return c.json({ error: "not found" }, 404);

  const [runs, heroes, difficulties] = await Promise.all([
    db.prepare(
      `SELECT id, seed, start_ts, difficulty, floors_reached, beaten, battles_won,
              battles_lost, lives_lost, endless_battles
       FROM run WHERE player_id = ? ORDER BY start_ts DESC`,
    ).bind(id).all(),
    db.prepare(
      `SELECT bu.hero_ref ref, cat.name,
              COUNT(DISTINCT b.id) n_battles,
              COUNT(DISTINCT CASE WHEN b.outcome = 'victory' THEN b.id END) battle_wins,
              COUNT(DISTINCT r.id) n_runs,
              COUNT(DISTINCT CASE WHEN r.beaten = 1 THEN r.id END) run_beats,
              (SELECT COUNT(*) FROM battle_death bd
                JOIN battle b2 ON b2.id = bd.battle_id JOIN run r2 ON r2.id = b2.run_id
                WHERE r2.player_id = ? AND bd.hero_ref = bu.hero_ref) deaths
       FROM battle_unit bu
       JOIN battle b ON b.id = bu.battle_id JOIN run r ON r.id = b.run_id
       LEFT JOIN catalog cat ON cat.entity_type = 'hero' AND cat.ref = bu.hero_ref
       WHERE r.player_id = ? AND bu.reserve = 0
       GROUP BY bu.hero_ref ORDER BY n_battles DESC`,
    ).bind(id, id).all(),
    db.prepare(
      `SELECT difficulty, COUNT(*) runs, SUM(beaten) beaten
       FROM run WHERE player_id = ? GROUP BY difficulty ORDER BY difficulty`,
    ).bind(id).all(),
  ]);

  return c.json(
    {
      player: {
        ...player,
        label: player.display_name ?? `Guest ${player.id.slice(0, 8)}`,
        anonymous: player.display_name === null,
      },
      runs: runs.results,
      heroes: heroes.results,
      difficulties: difficulties.results,
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

  const runRow = run as { player_id: string | null; seed: number | null;
    difficulty_index: number | null; is_challenge: number | null };
  const [battles, units, items, relics, deaths, acqs, shops, catalog, offers, events] = await Promise.all([
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
    // capture-derived shop offers for this run (deduped offer sets by floor)
    db.prepare(
      `SELECT c.total_floor, c.captured_at, o.kind, o.ref, o.rank, o.base_cost, o.discount_raw, o.frozen
       FROM capture c JOIN capture_shop_offer o ON o.capture_hash = c.hash
       WHERE c.player_id IS ? AND c.run_seed IS ?
       ORDER BY c.captured_at, o.kind, o.slot`,
    ).bind(runRow.player_id, runRow.seed).all<{
      total_floor: number | null; captured_at: string | null; kind: string; ref: string;
      rank: number | null; base_cost: number | null; discount_raw: number | null; frozen: number;
    }>(),
    db.prepare(
      `SELECT DISTINCT e.event_seq, e.resolved, e.outcome_text, e.summaries
       FROM capture c JOIN capture_event e ON e.capture_hash = c.hash
       WHERE c.player_id IS ? AND c.run_seed IS ? AND e.resolved = 1`,
    ).bind(runRow.player_id, runRow.seed).all(),
  ]);

  const names = new Map(catalog.results.map((r) => [`${r.entity_type}:${r.ref}`, r.name]));
  const rarities = new Map(catalog.results.map((r) => [`${r.entity_type}:${r.ref}`, r.rarity]));
  const resolve = (t: string, ref: string): { ref: string; name: string; rarity: string | null } => {
    // item refs appear log-native as tem_N; the catalog stores Item_N
    const norm = names.has(`${t}:${ref}`) ? ref : ref.replace(/^tem_/, "Item_");
    return {
      ref: norm,
      name: names.get(`${t}:${norm}`) ?? norm,
      rarity: rarities.get(`${t}:${norm}`) ?? null,
    };
  };

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
        ...(d.hero_ref ? { ref: d.hero_ref } : {}),
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

  // group capture offers into distinct offer-sets (per capture timestamp)
  const offerSets = new Map<string, typeof offers.results>();
  for (const o of offers.results) {
    const key = `${o.total_floor}|${o.captured_at}`;
    const arr = offerSets.get(key) ?? [];
    arr.push(o);
    offerSets.set(key, arr);
  }
  const seenSet = new Set<string>();
  const shopOffers = [...offerSets.entries()]
    .map(([key, list]) => ({
      floor: list[0]!.total_floor,
      captured_at: list[0]!.captured_at,
      offers: list.map((o) => ({
        ...resolve(o.kind, o.ref),
        kind: o.kind,
        rank: o.rank,
        base_cost: o.base_cost,
        // DiscountRaw is Q16: 16384 = 25% off
        price: o.base_cost !== null && o.discount_raw
          ? Math.floor(o.base_cost * (1 - o.discount_raw / 65536))
          : o.base_cost,
        on_sale: !!o.discount_raw,
        frozen: !!o.frozen,
      })),
      _sig: key && JSON.stringify(list.map((o) => `${o.kind}:${o.ref}:${o.discount_raw}`)),
    }))
    .filter((s) => {
      if (seenSet.has(s._sig)) return false;   // identical set captured twice
      seenSet.add(s._sig);
      return true;
    })
    .map(({ _sig, ...rest }) => rest);

  return c.json(
    {
      run: {
        ...run,
        difficulty_label: difficultyLabel(runRow.difficulty_index, runRow.is_challenge),
      },
      battles: battlesOut,
      acquisitions: acqsOut,
      shop_phases: shops.results,
      shop_offers_seen: shopOffers,
      event_outcomes: events.results,
    },
    200, { "Cache-Control": CACHE },
  );
});
