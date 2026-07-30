/**
 * Guildrun Compendium Worker: upload ingestion, admin (reparse / catalog seed /
 * aggregate), read API, cron aggregation, and static site hosting via assets.
 */

import { Hono } from "hono";
import type { Env } from "./env.js";
import { KVRawStore, R2RawStore } from "./storage.js";
import { handleUpload, reparseAll } from "./ingest.js";
import { materializeStats } from "./aggregate.js";
import { api } from "./api.js";

type App = { Bindings: Env };

const app = new Hono<App>();

// ---- rate limiting (per-IP, hourly window, KV counter) ----
async function rateLimited(env: Env, ip: string): Promise<boolean> {
  const key = `rl:${ip}:${new Date().toISOString().slice(0, 13)}`;
  const count = parseInt((await env.RATE_LIMIT.get(key)) ?? "0", 10);
  if (count >= 30) return true;
  await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: 7200 });
  return false;
}

async function verifyTurnstile(secret: string, token: string, ip: string): Promise<boolean> {
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, response: token, remoteip: ip }),
  });
  const data = (await res.json()) as { success: boolean };
  return data.success;
}

app.post("/api/upload", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  if (await rateLimited(c.env, ip)) return c.json({ error: "rate limited" }, 429);

  const form = await c.req.raw.formData();

  // Browser uploads carry a Turnstile token; the collect script identifies
  // itself instead and leans on the rate limit. Enforced only when the
  // Turnstile secret is configured.
  if (c.env.TURNSTILE_SECRET) {
    const token = form.get("cf-turnstile-response");
    const isScript = c.req.header("X-Upload-Source") === "collect-script";
    if (!isScript) {
      if (typeof token !== "string" || !(await verifyTurnstile(c.env.TURNSTILE_SECRET, token, ip))) {
        return c.json({ error: "turnstile verification failed" }, 403);
      }
    }
  }

  const store = new R2RawStore(c.env.RAW_R2);
  const result = await handleUpload(c.env, store, form);
  if (result.status === 200 && !result.body["duplicate"]) {
    c.executionCtx.waitUntil(materializeStats(c.env.DB));
  }
  return c.json(result.body, result.status as 200);
});

// ---- admin ----
function adminOk(c: { env: Env; req: { header: (k: string) => string | undefined } }): boolean {
  return !!c.env.ADMIN_TOKEN && c.req.header("X-Admin-Token") === c.env.ADMIN_TOKEN;
}

app.post("/api/admin/reparse", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 403);
  const result = await reparseAll(c.env, new R2RawStore(c.env.RAW_R2));
  const stats = await materializeStats(c.env.DB);
  return c.json({ ...result, stat_rows: stats.rows });
});

/** One-time KV -> R2 raw-blob migration (idempotent: skips keys already in R2). */
app.post("/api/admin/migrate-raw", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 403);
  const kv = new KVRawStore(c.env.RAW_LOGS);
  const r2 = new R2RawStore(c.env.RAW_R2);
  let copied = 0, skipped = 0, cursor: string | undefined;
  do {
    const page = await kv.list(cursor);
    for (const hash of page.hashes) {
      if ((await r2.get(hash)) !== null) { skipped++; continue; }
      const text = await kv.get(hash);
      if (text !== null) { await r2.put(hash, text); copied++; }
    }
    cursor = page.cursor;
  } while (cursor);
  return c.json({ copied, skipped });
});

app.post("/api/admin/aggregate", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 403);
  return c.json(await materializeStats(c.env.DB));
});

/** Seed the content catalog (output of tools/catalog/guildrun_assets.py). */
app.post("/api/admin/catalog", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 403);
  const body = (await c.req.json()) as {
    items?: Record<string, { Name?: string; Rarity?: string; [k: string]: unknown }>;
    relics?: Record<string, { Name?: string; Rarity?: string; [k: string]: unknown }>;
    heroes?: Record<string, { Name?: string; [k: string]: unknown }>;
    enemies?: Record<string, { Name?: string; [k: string]: unknown }>;
    hero_classes?: Record<string, { Name?: string; [k: string]: unknown }>;
  };
  const groups: [string, Record<string, { Name?: string; Rarity?: string }> | undefined][] = [
    ["item", body.items], ["relic", body.relics], ["hero", body.heroes],
    ["enemy", body.enemies], ["hero_class", body.hero_classes],
  ];
  const stmts = [];
  let n = 0;
  for (const [type, entries] of groups) {
    for (const [ref, entry] of Object.entries(entries ?? {})) {
      if (!entry.Name) continue;
      const { Name, Rarity, ...meta } = entry;
      stmts.push(
        c.env.DB.prepare(
          "INSERT OR REPLACE INTO catalog (entity_type, ref, game_version_id, name, rarity, meta) VALUES (?,?,0,?,?,?)",
        ).bind(type, ref, Name, Rarity ?? null, Object.keys(meta).length ? JSON.stringify(meta) : null),
      );
      n++;
    }
  }
  for (let i = 0; i < stmts.length; i += 40) await c.env.DB.batch(stmts.slice(i, i + 40));
  return c.json({ seeded: n });
});

app.route("/api", api);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await materializeStats(env.DB);
  },
};
