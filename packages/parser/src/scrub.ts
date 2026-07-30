/**
 * SteamID handling for ingest.
 *
 * Guildrun logs leak the player's SteamID64 in save-path lines, e.g.
 *   Deleting file at C:/users/steamuser/.../Saves/steam-76561198216751757\Run
 *
 * At ingest we (1) extract the ID to derive an anonymous player identity
 * (HMAC with a server-side salt — done by the caller, not here), then
 * (2) scrub the raw text before it is stored anywhere. The replacement
 * preserves length and format so scrubbed logs still parse identically.
 */

/** SteamID64s start with 7656119 and are 17 digits total. */
const STEAMID64_RE = /7656119\d{10}/g;

export function extractSteamIds(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(STEAMID64_RE)) ids.add(m[0]);
  return [...ids];
}

export function scrubSteamIds(text: string): string {
  return text.replace(STEAMID64_RE, "00000000000000000");
}
