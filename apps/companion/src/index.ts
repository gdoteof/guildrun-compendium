#!/usr/bin/env node
/**
 * Guildrun Companion — live run overlay for your browser.
 *
 * Tails the game's own log file (event-driven, appended bytes only), keeps a
 * live picture of your run, and serves a localhost page with tier badges for
 * your current context pulled from the community compendium.
 *
 *   guildrun-companion                      # autodetect the game
 *   guildrun-companion --game-dir <path>    # point at Guildrun_Data (or Logs)
 *   guildrun-companion --port 4646 --no-save-watch
 *
 * Resource budget (the contract, not an aspiration): zero CPU while the game
 * is idle; parsing touches only appended bytes; one SSE keepalive timer;
 * network = catalog once/24h + tiers on context change; disk = a <200KB cache
 * in the platform config dir.
 */

import { findGame } from "./paths.js";
import { LogTailer } from "./tailer.js";
import { LiveGame } from "./live.js";
import { CompendiumClient } from "./compendium.js";
import { RunSaveWatcher } from "./runsave.js";
import { CaptureUploader } from "./uploader.js";
import { CompanionServer } from "./server.js";

const DEFAULT_SERVER = "https://guildrun-compendium.laxity-03-hunger3397.workers.dev";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  if (has("help")) {
    console.log(
      "guildrun-companion [--game-dir <path>] [--port <n>] [--host <addr>]\n" +
      "                   [--server <url>] [--no-save-watch] [--save-dir <path>]\n" +
      "                   [--save-archive]   archive distinct Run-save states for research",
    );
    return;
  }

  const paths = findGame(arg("game-dir"));
  if (!paths) {
    console.error(
      "Could not find a Guildrun install.\n" +
      "Pass it explicitly:  guildrun-companion --game-dir \"<...>/Guildrun Demo/Guildrun_Data\"",
    );
    process.exit(1);
  }

  const client = new CompendiumClient(arg("server") ?? DEFAULT_SERVER);
  const game = new LiveGame();

  let server: CompanionServer;
  let pending = false;
  const notify = (): void => {
    // coalesce broadcasts so a burst of events costs one push
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      void server.broadcast();
    }, 200);
  };

  const tailer = new LogTailer(paths.logsDir, {
    onLines: (lines, file) => {
      game.feedLines(lines, file);
      if (game.changed()) notify();
    },
    onRotate: () => {
      game.reset();
      notify();
    },
    onError: (e) => console.error(`[tailer] ${e.message} (falling back to lazy polling)`),
  });

  let save: RunSaveWatcher | null = null;
  let uploader: CaptureUploader | null = null;
  const saveDir = arg("save-dir") ?? paths.saveDir;
  if (saveDir && !has("no-save-watch")) {
    const { configDir } = await import("./paths.js");
    const { join } = await import("node:path");
    const archiveDir = has("save-archive") ? join(configDir(), "save-captures") : null;
    if (archiveDir && !has("no-capture-upload")) {
      uploader = new CaptureUploader(archiveDir, saveDir, arg("server") ?? DEFAULT_SERVER);
    }
    let runFileWasPresent = false;
    save = new RunSaveWatcher(
      saveDir,
      () => {
        const present = save!.current().present;
        // run over: the game just deleted the Run file — ship the archive
        // and the log itself, so the run appears on the site with no manual step
        if (runFileWasPresent && !present && uploader) {
          void uploader.uploadPending().then((r) => {
            if (r.sent) console.log(`[captures] uploaded ${r.sent} run-save capture(s)`);
          });
          const active = tailer.status().activeFile;
          if (active && !has("no-log-upload")) {
            const logPath = `${paths.logsDir}/${active}`;
            void uploader.uploadLog(logPath, paths.bootConfig).then((ok) => {
              if (ok) console.log(`[logs] uploaded ${active} (run over)`);
            });
          }
        }
        runFileWasPresent = present;
        notify();
      },
      archiveDir,
    );
  }

  server = new CompanionServer({
    game,
    client,
    save,
    tailerStatus: () => tailer.status(),
  });

  const { activeFile } = tailer.start();
  save?.start();
  // startup sweep: captures left over from runs that ended while we were down
  if (uploader) {
    void uploader.uploadPending().then((r) => {
      if (r.sent) console.log(`[captures] uploaded ${r.sent} pending capture(s) from previous runs`);
    });
  }
  const host = arg("host") ?? "127.0.0.1";
  const port = await server.listen(parseInt(arg("port") ?? "4646", 10), host);

  console.log(`Guildrun Companion
  game    ${paths.gameDir}
  log     ${activeFile ?? "(none yet — waiting for the game to write one)"}
  saves   ${save ? paths.saveDir : "(not watching)"}
  ui      http://${host}:${port}/
`);

  const shutdown = (): void => {
    tailer.stop();
    save?.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
