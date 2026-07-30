export interface Env {
  DB: D1Database;
  /** legacy raw store; kept for the KV -> R2 migration endpoint */
  RAW_LOGS: KVNamespace;
  RAW_R2: R2Bucket;
  RATE_LIMIT: KVNamespace;
  ASSETS: Fetcher;
  MAX_FILES: string;
  MAX_FILE_BYTES: string;
  /** secrets (set via wrangler secret put / .dev.vars) */
  HMAC_SALT?: string;
  ADMIN_TOKEN?: string;
  TURNSTILE_SECRET?: string;
  SESSION_SECRET?: string;
  /** optional: official persona-name lookup; keyless XML fallback otherwise */
  STEAM_API_KEY?: string;
}

export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Anonymous player identity: HMAC-SHA256(server salt, SteamID64), hex. */
export async function playerHash(salt: string, steamId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(steamId));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
