/**
 * Localhost UI server. Binds 127.0.0.1 only (never exposed to the network
 * unless --host is passed for a second-device setup). State flows to the page
 * over Server-Sent Events — pushed when something changes, so neither side
 * polls. A 25s comment frame keeps intermediaries from dropping the stream.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { trackBelly, NIKLAS_REF, type BellyBite, type BellyReport } from "@guildrun/parser";
import { UI_HTML, BELLY_HTML, STAT_ICONS_CSS } from "./ui-embedded.js";
import type { LiveGame } from "./live.js";
import type { CompendiumClient, TierMap } from "./compendium.js";
import type { RunSaveWatcher } from "./runsave.js";
import { VERSION } from "./version.js";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");

/** A bite with the item named, for the Belly page. */
export interface NamedBite extends BellyBite {
  item_name: string | null;
  rarity: string | null;
}

export interface BellyState extends Omit<BellyReport, "bites"> {
  bites: NamedBite[];
  /** Niklas is in the party right now (the belly survives the run ending) */
  in_party: boolean;
}

export interface EnrichedState {
  live: ReturnType<LiveGame["state"]>;
  tiers: TierMap | null;
  belly: BellyState;
  names: {
    party: { ref: string; name: string; rank: number | null; items: { ref: string; name: string; rarity: string | null }[] }[];
    relics: { ref: string; name: string; rarity: string | null }[];
    sales: { kind: string; name: string; ref: string | null }[];
  };
  save: ReturnType<RunSaveWatcher["current"]> | null;
  tailer: { activeFile: string | null; offset: number; mode: string };
  version: string;
}

export class CompanionServer {
  private server: Server;
  private clients = new Set<ServerResponse>();
  private keepalive: NodeJS.Timeout;

  constructor(
    private deps: {
      game: LiveGame;
      client: CompendiumClient;
      save: RunSaveWatcher | null;
      tailerStatus: () => { activeFile: string | null; offset: number; mode: string };
    },
  ) {
    this.server = createServer((req, res) => {
      void this.route(req.url ?? "/", res);
    });
    // SSE keepalive comment — the only timer in the whole app
    this.keepalive = setInterval(() => {
      for (const c of this.clients) c.write(": keepalive\n\n");
    }, 25_000);
    this.keepalive.unref();
  }

  listen(port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        const addr = this.server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  close(): void {
    clearInterval(this.keepalive);
    for (const c of this.clients) c.end();
    this.server.close();
  }

  /** Push current state to all SSE clients (call when something changed). */
  async broadcast(): Promise<void> {
    if (!this.clients.size) return;
    const payload = `data: ${JSON.stringify(await this.enriched())}\n\n`;
    for (const c of this.clients) c.write(payload);
  }

  private async enriched(): Promise<EnrichedState> {
    const live = this.deps.game.state();
    const { client } = this.deps;
    await client.getCatalog();
    const tiers = await client.getTiers(live.context.difficulty, live.context.floor_band);
    // recomputed rather than cached with the live state: it needs the catalog,
    // which may only have arrived after the first state was derived. O(battles).
    const belly = trackBelly(this.deps.game.runBattles(), {
      itemStats: (ref) => client.itemStats(ref),
    });
    return {
      live,
      tiers,
      belly: {
        ...belly,
        bites: belly.bites.map((b) => ({
          ...b,
          item_name: b.item_ref ? client.name("item", b.item_ref) : null,
          rarity: b.item_ref ? client.rarity("item", b.item_ref) : null,
        })),
        in_party: live.party.some((h) => h.ref === NIKLAS_REF),
      },
      names: {
        party: live.party.map((h) => ({
          ref: h.ref,
          name: client.name("hero", h.ref),
          rank: h.rank,
          items: h.items.map((i) => ({
            ref: i, name: client.name("item", i), rarity: client.rarity("item", i),
          })),
        })),
        relics: live.relics.map((r) => ({
          ref: r, name: client.name("relic", r), rarity: client.rarity("relic", r),
        })),
        sales: (live.shop?.sales ?? []).map((s) => ({
          ...s, ref: client.refByName(s.kind, s.name),
        })),
      },
      save: this.deps.save?.current() ?? null,
      tailer: this.deps.tailerStatus(),
      version: VERSION,
    };
  }

  /** dev: live file for quick iteration; compiled binary: embedded copy */
  private page(res: ServerResponse, file: string, embedded: string, type = "text/html"): void {
    const diskCopy = join(UI_DIR, file);
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
    res.end(existsSync(diskCopy) ? readFileSync(diskCopy) : embedded);
  }

  private async route(url: string, res: ServerResponse): Promise<void> {
    const path = url.split("?")[0]!;
    try {
      if (path === "/" || path === "/index.html") {
        this.page(res, "index.html", UI_HTML);
      } else if (path === "/belly" || path === "/belly.html") {
        this.page(res, "belly.html", BELLY_HTML);
      } else if (path === "/stat-icons.css") {
        this.page(res, "stat-icons.css", STAT_ICONS_CSS, "text/css");
      } else if (path === "/state") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(await this.enriched()));
      } else if (path === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        this.clients.add(res);
        res.on("close", () => this.clients.delete(res));
        res.write(`data: ${JSON.stringify(await this.enriched())}\n\n`);
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  }
}
