/**
 * Compendium API client — network good-citizenship lives here.
 *
 *  - catalog: fetched once, cached on disk for 24h (it changes only when the
 *    game patches). ~100KB once a day, worst case.
 *  - tiers: fetched only when the run CONTEXT changes (difficulty or floor
 *    band — a handful of times per run), with an in-memory cache and a 5-min
 *    floor between refetches of the same context.
 *  - Everything degrades gracefully offline: the companion keeps working with
 *    whatever it has cached; missing tiers just render as no badge.
 */

import type { ItemStat } from "@guildrun/parser";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./paths.js";

const CATALOG_TTL_MS = 24 * 3600 * 1000;
const TIERS_TTL_MS = 5 * 60 * 1000;

export interface TierEntry {
  tier: string;
  lift: number;
  n_battles: number;
  n_runs: number;
}
export type TierMap = Record<string, Record<string, TierEntry>>; // entity_type -> ref -> entry

export interface CatalogEntry {
  name: string;
  rarity: string | null;
  /** the game's own sheet data — item Stats, hero base stats, descriptions… */
  meta?: { Stats?: { stat: string; value: number }[]; [k: string]: unknown };
}
export type Catalog = Record<string, Record<string, CatalogEntry>>;

export class CompendiumClient {
  private tiersCache = new Map<string, { at: number; tiers: TierMap }>();
  private catalog: Catalog | null = null;
  private nameIndex = new Map<string, string>(); // "type:name" -> ref

  constructor(private baseUrl: string) {
    mkdirSync(configDir(), { recursive: true });
  }

  async getCatalog(): Promise<Catalog | null> {
    if (this.catalog) return this.catalog;
    const cachePath = join(configDir(), "catalog-cache.json");
    if (existsSync(cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as {
          at: number; catalog: Catalog;
        };
        if (Date.now() - cached.at < CATALOG_TTL_MS) {
          this.setCatalog(cached.catalog);
          return this.catalog;
        }
      } catch { /* refetch */ }
    }
    try {
      const res = await fetch(`${this.baseUrl}/api/catalog`);
      if (!res.ok) return this.catalog;
      const catalog = (await res.json()) as Catalog;
      writeFileSync(cachePath, JSON.stringify({ at: Date.now(), catalog }));
      this.setCatalog(catalog);
    } catch {
      // offline: fall back to a stale disk cache if one exists
      if (existsSync(cachePath)) {
        try {
          this.setCatalog((JSON.parse(readFileSync(cachePath, "utf-8")) as { catalog: Catalog }).catalog);
        } catch { /* nothing cached */ }
      }
    }
    return this.catalog;
  }

  private setCatalog(catalog: Catalog): void {
    this.catalog = catalog;
    this.nameIndex.clear();
    for (const [type, entries] of Object.entries(catalog)) {
      for (const [ref, e] of Object.entries(entries)) {
        this.nameIndex.set(`${type}:${e.name}`, ref);
      }
    }
  }

  name(type: string, ref: string): string {
    return this.catalog?.[type]?.[ref]?.name ?? ref;
  }

  rarity(type: string, ref: string): string | null {
    return this.catalog?.[type]?.[ref]?.rarity ?? null;
  }

  /** Item stats as the game sheets define them — what Niklas gains by eating it. */
  itemStats(ref: string): ItemStat[] | null {
    const stats = this.catalog?.item?.[ref]?.meta?.Stats;
    return Array.isArray(stats) && stats.length ? stats : null;
  }

  refByName(type: string, name: string): string | null {
    return this.nameIndex.get(`${type}:${name}`) ?? null;
  }

  async getTiers(difficulty: number, floorBand: string): Promise<TierMap | null> {
    const key = `${difficulty}|${floorBand}`;
    const cached = this.tiersCache.get(key);
    if (cached && Date.now() - cached.at < TIERS_TTL_MS) return cached.tiers;
    try {
      const res = await fetch(
        `${this.baseUrl}/api/tiers?difficulty=${difficulty}&floor_band=${encodeURIComponent(floorBand)}`,
      );
      if (!res.ok) return cached?.tiers ?? null;
      const data = (await res.json()) as { tiers: TierMap };
      this.tiersCache.set(key, { at: Date.now(), tiers: data.tiers });
      return data.tiers;
    } catch {
      return cached?.tiers ?? null; // offline: stale beats nothing
    }
  }
}
