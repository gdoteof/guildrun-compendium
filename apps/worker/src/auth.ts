/**
 * Sign in through Steam — OpenID 2.0.
 *
 * Steam's OpenID needs NO API key: we redirect to steamcommunity.com/openid/
 * login, Steam sends the user back with a signed assertion, and we verify it
 * by POSTing the assertion back to Steam with mode=check_authentication
 * (Steam invalidates each assertion after one check, which also kills replay).
 *
 * The verified SteamID is hashed with the SAME server salt as ingest, so
 * signing in lands on the exact player row the user's anonymous uploads
 * created — every prior run is claimed automatically, no linking step.
 *
 * Persona name: the official route is GetPlayerSummaries (needs STEAM_API_KEY,
 * optional secret); without it we fall back to the public community profile
 * XML, which needs no key. Either way only the display name is stored.
 */

import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { type Env, playerHash } from "./env.js";

type App = { Bindings: Env };

const STEAM_OPENID = "https://steamcommunity.com/openid/login";
const CLAIMED_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
const SESSION_COOKIE = "session";
const SESSION_TTL_S = 30 * 24 * 3600;

// ---------------------------------------------------------------- sessions

const b64url = (buf: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer as ArrayBuffer)))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

export async function makeSession(secret: string, playerId: string): Promise<string> {
  const payload = b64url(new TextEncoder().encode(
    JSON.stringify({ p: playerId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S }),
  ));
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function readSession(secret: string, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if ((await hmac(secret, payload)) !== sig) return null;
  try {
    const std = payload.replaceAll("-", "+").replaceAll("_", "/");
    const data = JSON.parse(atob(std)) as { p?: string; exp?: number };
    if (!data.p || !data.exp || data.exp < Date.now() / 1000) return null;
    return data.p;
  } catch {
    return null;
  }
}

export async function sessionPlayerId(c: {
  env: Env;
  req: { raw: Request };
}): Promise<string | null> {
  const secret = c.env.SESSION_SECRET;
  if (!secret) return null;
  const cookie = c.req.raw.headers.get("Cookie") ?? "";
  const token = cookie.split(/;\s*/).find((x) => x.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  return readSession(secret, token);
}

// ---------------------------------------------------------------- persona

async function fetchPersonaName(env: Env, steamId: string): Promise<string | null> {
  if (env.STEAM_API_KEY) {
    try {
      const res = await fetch(
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${env.STEAM_API_KEY}&steamids=${steamId}`,
      );
      if (res.ok) {
        const data = (await res.json()) as { response?: { players?: { personaname?: string }[] } };
        const name = data.response?.players?.[0]?.personaname;
        if (name) return name;
      }
    } catch { /* fall through to XML */ }
  }
  // Keyless fallback: the long-standing public community profile XML.
  try {
    const res = await fetch(`https://steamcommunity.com/profiles/${steamId}/?xml=1`, {
      headers: { "User-Agent": "guildrun-compendium/0.1" },
    });
    if (res.ok) {
      const xml = await res.text();
      const m = /<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/s.exec(xml);
      if (m?.[1]) return m[1].slice(0, 64);
    }
  } catch { /* no name available */ }
  return null;
}

// ---------------------------------------------------------------- routes

export const auth = new Hono<App>();

auth.get("/login", (c) => {
  const origin = new URL(c.req.url).origin;
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.return_to": `${origin}/auth/steam/return`,
    "openid.realm": origin,
  });
  return c.redirect(`${STEAM_OPENID}?${params}`);
});

auth.get("/return", async (c) => {
  if (!c.env.SESSION_SECRET) return c.text("sign-in not configured", 503);
  const url = new URL(c.req.url);
  const origin = url.origin;

  // basic assertion shape checks before asking Steam
  if (url.searchParams.get("openid.mode") !== "id_res") return c.text("bad response", 400);
  if (url.searchParams.get("openid.op_endpoint") !== STEAM_OPENID) return c.text("bad endpoint", 400);
  if (!url.searchParams.get("openid.return_to")?.startsWith(origin)) return c.text("bad return_to", 400);
  const claimed = url.searchParams.get("openid.claimed_id") ?? "";
  const steamId = CLAIMED_ID_RE.exec(claimed)?.[1];
  if (!steamId) return c.text("bad claimed_id", 400);

  // verify the signature with Steam (stateless check_authentication)
  const verify = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (k.startsWith("openid.")) verify.set(k, v);
  }
  verify.set("openid.mode", "check_authentication");
  const res = await fetch(STEAM_OPENID, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: verify.toString(),
  });
  const body = await res.text();
  if (!/is_valid\s*:\s*true/.test(body)) return c.text("verification failed", 403);

  // same HMAC as ingest -> the verified identity IS the anonymous identity
  const playerId = await playerHash(c.env.HMAC_SALT ?? "dev-salt-not-for-production", steamId);
  const now = new Date().toISOString();
  await c.env.DB
    .prepare("INSERT OR IGNORE INTO player (id, first_seen) VALUES (?,?)")
    .bind(playerId, now)
    .run();
  const name = await fetchPersonaName(c.env, steamId);
  if (name) {
    await c.env.DB
      .prepare("UPDATE player SET display_name = ? WHERE id = ?")
      .bind(name, playerId)
      .run();
  }

  setCookie(c, SESSION_COOKIE, await makeSession(c.env.SESSION_SECRET, playerId), {
    httpOnly: true,
    secure: origin.startsWith("https"),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_S,
  });
  return c.redirect(`/player.html?id=${playerId}`);
});

auth.get("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/");
});

/** Who am I? 401 when signed out. Never exposes the SteamID (we don't store it). */
export async function handleMe(c: {
  env: Env;
  req: { raw: Request };
  json: (o: unknown, status?: number) => Response;
}): Promise<Response> {
  const playerId = await sessionPlayerId(c);
  if (!playerId) return c.json({ error: "not signed in" }, 401);
  const player = await c.env.DB
    .prepare("SELECT id, display_name, first_seen FROM player WHERE id = ?")
    .bind(playerId)
    .first<{ id: string; display_name: string | null; first_seen: string }>();
  if (!player) return c.json({ error: "not signed in" }, 401);
  return c.json({
    player: {
      ...player,
      label: player.display_name ?? `Guest ${player.id.slice(0, 8)}`,
      anonymous: player.display_name === null,
    },
  });
}
