/**
 * Capture uploader: ships archived Run-save states to the compendium when a
 * run ends (the watcher sees the game delete the Run file) and sweeps
 * leftovers at startup. Uploaded files move to save-captures/uploaded/ so
 * nothing is sent twice and the user can always see what left the machine.
 *
 * Identity: the SteamID from the save-dir path (steam-<id>), sent alongside
 * and hashed server-side with the same salt as log ingestion — so capture
 * facts land on the same player row as everything else.
 */

import { readdirSync, readFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

export class CaptureUploader {
  private uploading = false;

  constructor(
    private archiveDir: string,
    private saveDir: string,
    private serverUrl: string,
  ) {}

  /** Ship the active log (+ boot.config) so runs appear on the site without a
   * manual collect step. Server-side dedupe makes repeats cheap: identical
   * uploads short-circuit on content hash, and re-sent runs are "already
   * known" unless the new copy has more battles. */
  async uploadLog(logPath: string, bootConfigPath: string | null): Promise<boolean> {
    try {
      const form = new FormData();
      form.append("files", new File([readFileSync(logPath)], basename(logPath)));
      if (bootConfigPath && existsSync(bootConfigPath)) {
        form.append("files", new File([readFileSync(bootConfigPath)], "boot.config"));
      }
      const res = await fetch(`${this.serverUrl}/api/upload`, {
        method: "POST",
        body: form,
        headers: { "X-Upload-Source": "companion" },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Best-effort; failures leave files in place for the next attempt. */
  async uploadPending(): Promise<{ sent: number; skipped: boolean }> {
    if (this.uploading) return { sent: 0, skipped: true };
    this.uploading = true;
    try {
      if (!existsSync(this.archiveDir)) return { sent: 0, skipped: false };
      const pending = readdirSync(this.archiveDir).filter((f) => f.endsWith(".json"));
      if (!pending.length) return { sent: 0, skipped: false };

      const steamId = /steam-(\d{17})/.exec(this.saveDir)?.[1];
      const form = new FormData();
      if (steamId) form.set("steam_id", steamId);
      for (const name of pending) {
        form.append(
          "files",
          new File([readFileSync(join(this.archiveDir, name))], basename(name), {
            type: "application/json",
          }),
        );
      }
      const res = await fetch(`${this.serverUrl}/api/captures`, {
        method: "POST",
        body: form,
        headers: { "X-Upload-Source": "companion" },
      });
      if (!res.ok) return { sent: 0, skipped: false };

      const doneDir = join(this.archiveDir, "uploaded");
      mkdirSync(doneDir, { recursive: true });
      for (const name of pending) {
        renameSync(join(this.archiveDir, name), join(doneDir, name));
      }
      return { sent: pending.length, skipped: false };
    } catch {
      return { sent: 0, skipped: false };
    } finally {
      this.uploading = false;
    }
  }
}
