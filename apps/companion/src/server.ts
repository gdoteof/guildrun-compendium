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
import { UI_HTML } from "./ui-embedded.js";
import type { LiveGame } from "./live.js";
import type { CompendiumClient, TierMap } from "./compendium.js";
import type { RunSaveWatcher } from "./runsave.js";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");

export interface EnrichedState {
  live: ReturnType<LiveGame["state"]>;
  tiers: TierMap | null;
  names: {
    party: { ref: string; name: string; rank: number | null; items: { ref: string; name: string; rarity: string | null }[] }[];
    relics: { ref: string; name: string; rarity: string | null }[];
    sales: { kind: string; name: string; ref: string | null }[];
  };
  save: ReturnType<RunSaveWatcher["current"]> | null;
  tailer: { activeFile: string | null; offset: number; mode: string };
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
    return {
      live,
      tiers,
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
    };
  }

  private async route(url: string, res: ServerResponse): Promise<void> {
    const path = url.split("?")[0]!;
    try {
      if (path === "/" || path === "/index.html") {
        // dev: live file for quick iteration; compiled binary: embedded copy
        const diskCopy = join(UI_DIR, "index.html");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(existsSync(diskCopy) ? readFileSync(diskCopy) : UI_HTML);
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
