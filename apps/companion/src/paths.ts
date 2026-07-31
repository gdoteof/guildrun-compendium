/**
 * Locate the Guildrun install (for Logs/) and save dir (for the Run file)
 * across Windows, macOS, Linux native, and Linux/Proton. Everything is
 * overridable with flags — autodetection is convenience, not policy.
 *
 * Log location differs by platform:
 *  - Windows/Linux: the game's NLog files land next to the player data,
 *    Guildrun_Data/Logs/YYYY-MM-DD-game.log
 *  - macOS: the game ships as an .app bundle (Data at Contents/Resources/Data)
 *    and the bundle isn't writable, so the game log stream is captured in
 *    Unity's player log instead: ~/Library/Logs/Leyline/Guildrun/Player.log
 *    (truncated on every launch; previous session in Player-prev.log). The
 *    parser keys on the game's [ts] [LEVEL] [src] line shape and skips
 *    Unity's own noise, so tailing Player.log feeds the same pipeline.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();

export const GAME_LOG_RE = /^\d{4}-\d{2}-\d{2}-game\.log$/;
export const PLAYER_LOG_RE = /^Player\.log$/;

const MAC_PERSISTENT = join(home, "Library/Application Support/Leyline/Guildrun");
const MAC_UNITY_LOGS = join(home, "Library/Logs/Leyline/Guildrun");

const STEAM_COMMON_ROOTS = [
  // Windows
  "C:/Program Files (x86)/Steam/steamapps/common",
  "C:/Program Files/Steam/steamapps/common",
  "D:/SteamLibrary/steamapps/common",
  "E:/SteamLibrary/steamapps/common",
  // macOS
  join(home, "Library/Application Support/Steam/steamapps/common"),
  // Linux native / snap / flatpak
  join(home, ".steam/steam/steamapps/common"),
  join(home, ".local/share/Steam/steamapps/common"),
  join(home, "snap/steam/common/.local/share/Steam/steamapps/common"),
  join(home, ".var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common"),
];

// macOS: the bundle may also live outside a Steam library
const MAC_APP_ROOTS = [join(home, "Applications"), "/Applications"];

export interface GamePaths {
  gameDir: string;      // .../Guildrun*/ (or the .app bundle on macOS)
  logsDir: string;      // dir holding the tailable log
  logPattern: RegExp;   // which file in logsDir is the live log
  bootConfig: string | null;
  saveDir: string | null;   // .../Leyline/Guildrun/Saves/steam-<id>  (holds Run/Profile)
}

function findSaveDir(steamRoot: string | null): string | null {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    candidates.push(join(home, "AppData/LocalLow/Leyline/Guildrun/Saves"));
  }
  if (process.platform === "darwin") {
    candidates.push(join(MAC_PERSISTENT, "Saves"));
  }
  if (steamRoot) {
    // Proton prefix (appid may vary between demo/full game — scan compatdata)
    const compat = join(steamRoot, "steamapps/compatdata");
    if (existsSync(compat)) {
      for (const appid of safeList(compat)) {
        const p = join(
          compat, appid,
          "pfx/drive_c/users/steamuser/AppData/LocalLow/Leyline/Guildrun/Saves",
        );
        if (existsSync(p)) candidates.push(p);
      }
    }
  }
  for (const savesRoot of candidates) {
    for (const entry of safeList(savesRoot)) {
      if (entry.startsWith("steam-")) return join(savesRoot, entry);
    }
  }
  return null;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** macOS: resolve a dir that is (or contains) the .app to its Data dir. */
function macDataDir(dir: string): { appDir: string; dataDir: string } | null {
  const probe = (app: string): { appDir: string; dataDir: string } | null => {
    const d = join(app, "Contents/Resources/Data");
    return existsSync(d) ? { appDir: app, dataDir: d } : null;
  };
  if (dir.endsWith(".app")) return probe(dir);
  for (const e of safeList(dir)) {
    if (e.endsWith(".app")) {
      const hit = probe(join(dir, e));
      if (hit) return hit;
    }
  }
  return null;
}

/** macOS: pick the log dir — game logs if they exist anywhere, else the
 * Unity player log. */
function macLogDir(dataDir: string | null): { logsDir: string; logPattern: RegExp } | null {
  const gameLogDirs = [
    dataDir ? join(dataDir, "Logs") : null,
    join(MAC_PERSISTENT, "Logs"),
  ].filter((p): p is string => p !== null);
  for (const p of gameLogDirs) {
    if (safeList(p).some((f) => GAME_LOG_RE.test(f))) {
      return { logsDir: p, logPattern: GAME_LOG_RE };
    }
  }
  if (existsSync(MAC_UNITY_LOGS)) {
    return { logsDir: MAC_UNITY_LOGS, logPattern: PLAYER_LOG_RE };
  }
  for (const p of gameLogDirs) {
    if (existsSync(p)) return { logsDir: p, logPattern: GAME_LOG_RE };
  }
  return null;
}

function fromDataLayout(gameDir: string): GamePaths | null {
  const logsDir = join(gameDir, "Guildrun_Data", "Logs");
  if (!existsSync(logsDir)) return null;
  return {
    gameDir,
    logsDir,
    logPattern: GAME_LOG_RE,
    bootConfig: existsSync(join(gameDir, "Guildrun_Data", "boot.config"))
      ? join(gameDir, "Guildrun_Data", "boot.config") : null,
    saveDir: findSaveDir(guessSteamRoot(gameDir)),
  };
}

function fromMacBundle(dir: string): GamePaths | null {
  const hit = macDataDir(dir);
  const log = macLogDir(hit?.dataDir ?? null);
  if (!log) return null;
  const bootConfig = hit && existsSync(join(hit.dataDir, "boot.config"))
    ? join(hit.dataDir, "boot.config") : null;
  return {
    gameDir: hit?.appDir ?? dir,
    ...log,
    bootConfig,
    saveDir: findSaveDir(guessSteamRoot(dir)),
  };
}

export function findGame(explicitDir?: string): GamePaths | null {
  if (explicitDir) {
    let gameDir = explicitDir.replace(/[/\\]+$/, "");
    // a dir that directly holds the live log (Player.log or *-game.log)
    const entries = safeList(gameDir);
    if (entries.some((f) => PLAYER_LOG_RE.test(f)) && !gameDir.endsWith("Logs")) {
      return {
        gameDir, logsDir: gameDir, logPattern: PLAYER_LOG_RE,
        bootConfig: null, saveDir: findSaveDir(null),
      };
    }
    if (process.platform === "darwin" && (gameDir.endsWith(".app") || macDataDir(gameDir))) {
      return fromMacBundle(gameDir);
    }
    // accept the game dir, Guildrun_Data, or the Logs dir itself
    if (gameDir.endsWith("Logs")) gameDir = join(gameDir, "../..");
    else if (gameDir.endsWith("Guildrun_Data")) gameDir = join(gameDir, "..");
    return fromDataLayout(gameDir);
  }

  for (const root of STEAM_COMMON_ROOTS) {
    if (!existsSync(root)) continue;
    for (const name of safeList(root)) {
      if (!name.toLowerCase().startsWith("guildrun")) continue;
      const gameDir = join(root, name);
      const found = fromDataLayout(gameDir)
        ?? (process.platform === "darwin" ? fromMacBundle(gameDir) : null);
      if (found) return found;
    }
  }
  if (process.platform === "darwin") {
    // bundle outside a Steam library (~/Applications), or logs-only fallback:
    // the Unity player log works even when the install isn't discoverable
    for (const root of MAC_APP_ROOTS) {
      for (const name of safeList(root)) {
        if (!name.toLowerCase().startsWith("guildrun") || !name.endsWith(".app")) continue;
        const found = fromMacBundle(join(root, name));
        if (found) return found;
      }
    }
    if (existsSync(MAC_UNITY_LOGS)) {
      return {
        gameDir: MAC_UNITY_LOGS,
        logsDir: MAC_UNITY_LOGS,
        logPattern: PLAYER_LOG_RE,
        bootConfig: null,
        saveDir: findSaveDir(null),
      };
    }
  }
  return null;
}

/** .../Steam/steamapps/common/Guildrun X -> .../Steam */
function guessSteamRoot(gameDir: string): string | null {
  const m = /^(.*[/\\]Steam)[/\\]steamapps[/\\]common[/\\]/.exec(gameDir + "/");
  return m?.[1] ?? null;
}

/** Platform config dir: ~/.config | ~/Library/Application Support | %APPDATA% */
export function configDir(): string {
  if (process.platform === "win32") {
    return join(process.env["APPDATA"] ?? join(home, "AppData/Roaming"), "guildrun-companion");
  }
  if (process.platform === "darwin") {
    return join(home, "Library/Application Support/guildrun-companion");
  }
  return join(process.env["XDG_CONFIG_HOME"] ?? join(home, ".config"), "guildrun-companion");
}
