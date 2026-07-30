import type { Stage } from "./types.js";

const STAGE_RE = /^Stage_(\d+)$/;

/**
 * Stage IDs decode as <difficulty><floor:2><variant:2>, with three special forms:
 *
 *   Stage_10000        fixed opening encounter (floor 0)
 *   Stage_101/102/103  endless maps, entered only after clearing floor 13
 *   Stage_5xxxx        optional event-fight encounter, not a campaign floor
 *   Stage_30102        difficulty 3, floor 1, variant 2
 *   Stage_301002       difficulty 3, floor 10, variant 2
 */
export function parseStage(stageId: string): Stage | null {
  const m = STAGE_RE.exec(stageId);
  if (!m) return null;
  const d = m[1]!;
  const base: Stage = { raw: stageId, difficulty: null, floor: null, variant: null, kind: "unknown" };
  if (d === "10000") {
    return { ...base, floor: 0, variant: 0, kind: "opening" };
  }
  if (d.length === 3) {
    return { ...base, kind: "endless", endless_map: parseInt(d[2]!, 10) };
  }
  let di: number, fl: number, va: number;
  if (d.length === 5) {
    di = parseInt(d[0]!, 10);
    fl = parseInt(d.slice(1, 3), 10);
    va = parseInt(d.slice(3, 5), 10);
  } else if (d.length === 6) {
    di = parseInt(d[0]!, 10);
    fl = parseInt(d.slice(1, 4), 10);
    va = parseInt(d.slice(4, 6), 10);
  } else {
    return base;
  }
  if (di === 5) {
    // event-fight pool; floor digits are pool indices, not campaign floors
    return { ...base, variant: va, kind: "event_fight", pool: fl };
  }
  return { raw: stageId, difficulty: di, floor: fl, variant: va, kind: "campaign" };
}
