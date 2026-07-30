/**
 * Aggregation: materialize the `stat` table from facts.
 *
 * Method ("Elo" adapted to PvE): per context (version × difficulty × floor
 * band), entity score = empirical-Bayes shrunk success rate
 *     score = (wins + k·p0) / (n + k)
 * against the contextual baseline p0 (overall success rate in that context),
 * lift = score / p0, tiered S/A/B/C/D on fixed lift thresholds. Two outcome
 * families: battle-won (banded contexts) and run-beaten (band='all' rows).
 * Data volume is tiny relative to D1, so we pull finest-grain grouped rows
 * and do rollups in JS.
 */

const K_BATTLE = 20;
const K_RUN = 8;

const BAND_SQL = `CASE
  WHEN b.stage_kind = 'endless' THEN 'endless'
  WHEN b.stage_kind IN ('campaign','opening') AND b.floor <= 4 THEN '1-4'
  WHEN b.stage_kind IN ('campaign','opening') AND b.floor <= 9 THEN '6-9'
  WHEN b.stage_kind IN ('campaign','opening') THEN '10-13'
  ELSE NULL END`;

interface GroupRow {
  ref: string;
  v: string | null;
  d: number | null;
  band: string | null;
  n: number;
  w: number;
}

interface Acc {
  n_battles: number; battle_wins: number;
  n_runs: number; run_beats: number;
  deaths: number;
}

type Key = string; // entity_type|ref|version|difficulty|band

function tierFor(lift: number | null): string | null {
  if (lift === null) return null;
  if (lift >= 1.1) return "S";
  if (lift >= 1.03) return "A";
  if (lift >= 0.97) return "B";
  if (lift >= 0.9) return "C";
  return "D";
}

export async function materializeStats(db: D1Database): Promise<{ rows: number }> {
  const q = async (sql: string): Promise<GroupRow[]> =>
    (await db.prepare(sql).all<GroupRow>()).results;

  // ---- baselines ----
  const battleBase = await q(`
    SELECT 'all' ref, gv.label v, r.difficulty d, ${BAND_SQL} band,
           COUNT(*) n, SUM(b.outcome = 'victory') w
    FROM battle b JOIN run r ON r.id = b.run_id
    LEFT JOIN game_version gv ON gv.id = r.game_version_id
    WHERE b.outcome IS NOT NULL
    GROUP BY v, d, band`);
  const runBase = await q(`
    SELECT 'all' ref, gv.label v, r.difficulty d, NULL band, COUNT(*) n, SUM(r.beaten) w
    FROM run r LEFT JOIN game_version gv ON gv.id = r.game_version_id
    GROUP BY v, d`);

  // ---- per-entity exposures (finest grain) ----
  const heroBattle = await q(`
    SELECT bu.hero_ref ref, gv.label v, r.difficulty d, ${BAND_SQL} band,
           COUNT(DISTINCT b.id) n,
           COUNT(DISTINCT CASE WHEN b.outcome = 'victory' THEN b.id END) w
    FROM battle_unit bu
    JOIN battle b ON b.id = bu.battle_id JOIN run r ON r.id = b.run_id
    LEFT JOIN game_version gv ON gv.id = r.game_version_id
    WHERE bu.reserve = 0 AND b.outcome IS NOT NULL
    GROUP BY bu.hero_ref, v, d, band`);
  const heroRun = await q(`
    SELECT bu.hero_ref ref, gv.label v, r.difficulty d, NULL band,
           COUNT(DISTINCT r.id) n,
           COUNT(DISTINCT CASE WHEN r.beaten = 1 THEN r.id END) w
    FROM battle_unit bu
    JOIN battle b ON b.id = bu.battle_id JOIN run r ON r.id = b.run_id
    LEFT JOIN game_version gv ON gv.id = r.game_version_id
    WHERE bu.reserve = 0
    GROUP BY bu.hero_ref, v, d`);
  const heroDeaths = await q(`
    SELECT bd.hero_ref ref, gv.label v, r.difficulty d, ${BAND_SQL} band,
           COUNT(*) n, 0 w
    FROM battle_death bd
    JOIN battle b ON b.id = bd.battle_id JOIN run r ON r.id = b.run_id
    LEFT JOIN game_version gv ON gv.id = r.game_version_id
    WHERE bd.hero_ref IS NOT NULL
    GROUP BY bd.hero_ref, v, d, band`);

  const itemBattle = await q(`
    SELECT bi.item_ref ref, gv.label v, r.difficulty d, ${BAND_SQL} band,
           COUNT(DISTINCT b.id) n,
           COUNT(DISTINCT CASE WHEN b.outcome = 'victory' THEN b.id END) w
    FROM battle_unit_item bi
    JOIN battle b ON b.id = bi.battle_id JOIN run r ON r.id = b.run_id
    LEFT JOIN game_version gv ON gv.id = r.game_version_id
    WHERE b.outcome IS NOT NULL
    GROUP BY bi.item_ref, v, d, band`);
  const itemRun = await q(`
    SELECT bi.item_ref ref, gv.label v, r.difficulty d, NULL band,
           COUNT(DISTINCT r.id) n,
           COUNT(DISTINCT CASE WHEN r.beaten = 1 THEN r.id END) w
    FROM battle_unit_item bi
    JOIN battle b ON b.id = bi.battle_id JOIN run r ON r.id = b.run_id
    LEFT JOIN game_version gv ON gv.id = r.game_version_id
    GROUP BY bi.item_ref, v, d`);

  const relicBattle = await q(`
    SELECT br.relic_ref ref, gv.label v, r.difficulty d, ${BAND_SQL} band,
           COUNT(DISTINCT b.id) n,
           COUNT(DISTINCT CASE WHEN b.outcome = 'victory' THEN b.id END) w
    FROM battle_relic br
    JOIN battle b ON b.id = br.battle_id JOIN run r ON r.id = b.run_id
    LEFT JOIN game_version gv ON gv.id = r.game_version_id
    WHERE b.outcome IS NOT NULL
    GROUP BY br.relic_ref, v, d, band`);
  const relicRun = await q(`
    SELECT br.relic_ref ref, gv.label v, r.difficulty d, NULL band,
           COUNT(DISTINCT r.id) n,
           COUNT(DISTINCT CASE WHEN r.beaten = 1 THEN r.id END) w
    FROM battle_relic br
    JOIN battle b ON b.id = br.battle_id JOIN run r ON r.id = b.run_id
    LEFT JOIN game_version gv ON gv.id = r.game_version_id
    GROUP BY br.relic_ref, v, d`);

  // ---- JS rollups over (version, difficulty, band) with 'all' sentinels ----
  const ctxVariants = (v: string | null, d: number | null, band: string | null): [string, number, string][] => {
    const vs = [...new Set(["all", v ?? "unknown"])];
    const ds = [...new Set([0, d ?? 0])];
    const bands = [...new Set(["all", band ?? "all"])];
    const out: [string, number, string][] = [];
    for (const vv of vs) for (const dd of ds) for (const bb of bands) out.push([vv, dd, bb]);
    return out;
  };

  const acc = new Map<Key, Acc>();
  const bump = (
    entityType: string, row: GroupRow,
    field: "battle" | "run" | "deaths",
  ): void => {
    for (const [vv, dd, bb] of ctxVariants(row.v, row.d, field === "run" ? null : row.band)) {
      // run metrics live only on band='all' rows
      if (field === "run" && bb !== "all") continue;
      const key = `${entityType}|${row.ref}|${vv}|${dd}|${bb}`;
      const a = acc.get(key) ?? { n_battles: 0, battle_wins: 0, n_runs: 0, run_beats: 0, deaths: 0 };
      if (field === "battle") { a.n_battles += row.n; a.battle_wins += row.w; }
      else if (field === "run") { a.n_runs += row.n; a.run_beats += row.w; }
      else a.deaths += row.n;
      acc.set(key, a);
    }
  };

  for (const r of battleBase) bump("baseline", r, "battle");
  for (const r of runBase) bump("baseline", r, "run");
  for (const r of heroBattle) bump("hero", r, "battle");
  for (const r of heroRun) bump("hero", r, "run");
  for (const r of heroDeaths) bump("hero", r, "deaths");
  for (const r of itemBattle) bump("item", r, "battle");
  for (const r of itemRun) bump("item", r, "run");
  for (const r of relicBattle) bump("relic", r, "battle");
  for (const r of relicRun) bump("relic", r, "run");

  const baseline = (v: string, d: number, b: string): Acc | undefined =>
    acc.get(`baseline|all|${v}|${d}|${b}`);

  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [
    db.prepare("DELETE FROM stat"),
  ];
  let rows = 0;
  for (const [key, a] of acc) {
    const [entityType, ref, v, dStr, band] = key.split("|") as [string, string, string, string, string];
    if (entityType === "baseline") continue;
    const base = baseline(v, parseInt(dStr, 10), band);
    const p0b = base && base.n_battles ? base.battle_wins / base.n_battles : null;
    const p0r = base && base.n_runs ? base.run_beats / base.n_runs : null;
    const battleScore = p0b !== null && a.n_battles
      ? (a.battle_wins + K_BATTLE * p0b) / (a.n_battles + K_BATTLE) : null;
    const runScore = p0r !== null && a.n_runs
      ? (a.run_beats + K_RUN * p0r) / (a.n_runs + K_RUN) : null;
    const battleLift = battleScore !== null && p0b ? battleScore / p0b : null;
    const runLift = runScore !== null && p0r ? runScore / p0r : null;
    const tier = band === "all"
      ? tierFor(a.n_runs >= 5 && runLift !== null ? runLift : battleLift)
      : tierFor(battleLift);
    stmts.push(
      db.prepare(
        `INSERT INTO stat (entity_type, ref, ctx_version, ctx_difficulty, ctx_floor_band,
           n_battles, battle_wins, n_runs, run_beats, deaths,
           battle_score, run_score, battle_lift, run_lift, tier, computed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        entityType, ref, v, parseInt(dStr, 10), band,
        a.n_battles, a.battle_wins, a.n_runs, a.run_beats, a.deaths,
        battleScore, runScore, battleLift, runLift, tier, now,
      ),
    );
    rows++;
  }
  for (let i = 0; i < stmts.length; i += 40) {
    await db.batch(stmts.slice(i, i + 40));
  }
  return { rows };
}
