/**
 * Locate the Guildrun install (for Logs/) and save dir (for the Run file)
 * across Windows, macOS, Linux native, and Linux/Proton. Everything is
 * overridable with flags — autodetection is convenience, not policy.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();

const STEAM_COMMON_ROOTS = [
  // Windows
  "C:/Program Files (x86)/Steam/steamapps/common",
  "C:/Program Files/Steam/steamapps/common",
  "D:/SteamLibrary/steamapps/common",
  "E:/SteamLibrary/steamapps/common",
  // macOS (Steam, plus non-Steam installs of the .app bundle)
  join(home, "Library/Application Support/Steam/steamapps/common"),
  join(home, "Applications"),
  "/Applications",
  // Linux native / snap / flatpak
  join(home, ".steam/steam/steamapps/common"),
  join(home, ".local/share/Steam/steamapps/common"),
  join(home, "snap/steam/common/.local/share/Steam/steamapps/common"),
  join(home, ".var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common"),
];

export interface GamePaths {
  gameDir: string;      // .../Guildrun*/   (on macOS the folder holding Guildrun.app)
  logsDir: string;      // .../Guildrun_Data/Logs, or .../Guildrun.app/Contents/Logs
  bootConfig: string | null;
  saveDir: string | null;   // .../Leyline/Guildrun/Saves/steam-<id>  (holds Run/Profile)
}

/**
 * Where the game keeps its logs and boot.config, relative to the game dir.
 * macOS ships a .app bundle: Unity's data dir is Contents/Resources/Data and
 * the game writes its logs to Contents/Logs (Unity's own Player.log, which
 * lives in ~/Library/Logs/Leyline/Guildrun, is *not* the log we parse).
 */
function layouts(gameDir: string): Array<{ logsDir: string; bootConfig: string }> {
  const out = [{
    logsDir: join(gameDir, "Guildrun_Data", "Logs"),
    bootConfig: join(gameDir, "Guildrun_Data", "boot.config"),
  }];
  const bundles = gameDir.toLowerCase().endsWith(".app")
    ? [gameDir]                                          // the .app itself was passed
    : safeList(gameDir).filter((n) => n.toLowerCase().endsWith(".app")).map((n) => join(gameDir, n));
  for (const app of bundles) {
    out.push({
      logsDir: join(app, "Contents", "Logs"),
      bootConfig: join(app, "Contents", "Resources", "Data", "boot.config"),
    });
  }
  return out;
}

function resolveLayout(gameDir: string): GamePaths | null {
  for (const l of layouts(gameDir)) {
    if (!existsSync(l.logsDir)) continue;
    return {
      gameDir,
      logsDir: l.logsDir,
      bootConfig: existsSync(l.bootConfig) ? l.bootConfig : null,
      saveDir: findSaveDir(guessSteamRoot(gameDir)),
    };
  }
  return null;
}

function findSaveDir(steamRoot: string | null): string | null {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    candidates.push(join(home, "AppData/LocalLow/Leyline/Guildrun/Saves"));
  }
  if (process.platform === "darwin") {
    candidates.push(join(home, "Library/Application Support/Leyline/Guildrun/Saves"));
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

export function findGame(explicitDir?: string): GamePaths | null {
  const roots = explicitDir ? [] : STEAM_COMMON_ROOTS;

  if (explicitDir) {
    // accept the game dir, Guildrun_Data, the .app bundle, or the Logs dir itself
    let gameDir = explicitDir.replace(/[/\\]+$/, "");
    if (gameDir.endsWith("Logs")) {
      // .../Guildrun_Data/Logs  or  .../Guildrun.app/Contents/Logs
      gameDir = join(gameDir, "../..");
      if (gameDir.toLowerCase().endsWith(".app")) gameDir = join(gameDir, "..");
    } else if (gameDir.endsWith("Guildrun_Data")) gameDir = join(gameDir, "..");
    else if (gameDir.toLowerCase().endsWith(".app")) gameDir = join(gameDir, "..");
    return resolveLayout(gameDir);
  }

  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of safeList(root)) {
      if (!name.toLowerCase().startsWith("guildrun")) continue;
      const found = resolveLayout(join(root, name));
      if (found) return found;
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
