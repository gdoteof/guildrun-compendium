/**
 * Event-driven log tailing. Good-citizen rules, enforced here:
 *
 *  - fs.watch on the Logs DIRECTORY (inotify / FSEvents / ReadDirectoryChangesW)
 *    — zero CPU while the game is idle; no stat-polling loops. If watch fails
 *    (network drives, exotic mounts), fall back to fs.watchFile at a lazy 5s.
 *  - We track a byte offset per file and read ONLY appended bytes with a
 *    positioned read — the file is never re-read, however big it grows.
 *  - Change events are coalesced (150ms) so combat log bursts cost one read.
 *  - Rotation-aware: the active file is always `YYYY-MM-DD-game.log`; a new
 *    active file (new day / restart) starts from offset 0, and a shrink is
 *    treated as truncation.
 */

import { closeSync, openSync, readSync, fstatSync, watch, watchFile, unwatchFile, existsSync, readdirSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

const ACTIVE_RE = /^\d{4}-\d{2}-\d{2}-game\.log$/;

export interface TailerEvents {
  onLines: (lines: string[], fileName: string) => void;
  onRotate?: (fileName: string) => void;
  onError?: (err: Error) => void;
}

export class LogTailer {
  private offset = 0;
  private activeFile: string | null = null;
  private carry = "";                    // partial last line between reads
  private watcher: FSWatcher | null = null;
  private pollFallback = false;
  private debounce: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private logsDir: string,
    private events: TailerEvents,
  ) {}

  /** Pick the active file, read it from the start (catch-up), then watch. */
  start(): { activeFile: string | null } {
    this.activeFile = this.findActiveFile();
    if (this.activeFile) this.readAppended();     // catch-up from offset 0
    try {
      this.watcher = watch(this.logsDir, { persistent: true }, () => this.schedule());
      this.watcher.on("error", (e) => {
        this.events.onError?.(e as Error);
        this.startPollFallback();
      });
    } catch (e) {
      this.events.onError?.(e as Error);
      this.startPollFallback();
    }
    return { activeFile: this.activeFile };
  }

  stop(): void {
    this.closed = true;
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
    if (this.pollFallback && this.activeFile) {
      unwatchFile(join(this.logsDir, this.activeFile));
    }
  }

  status(): { activeFile: string | null; offset: number; mode: string } {
    return {
      activeFile: this.activeFile,
      offset: this.offset,
      mode: this.pollFallback ? "poll-5s" : "watch",
    };
  }

  private startPollFallback(): void {
    if (this.pollFallback || this.closed) return;
    this.pollFallback = true;
    // lazy stat-poll of the single active file — the graceful-degradation
    // path, still no content re-reads
    const target = (): string => join(this.logsDir, this.activeFile ?? "");
    watchFile(target(), { interval: 5000 }, () => this.schedule());
  }

  /** Coalesce bursts: combat can emit dozens of writes per second. */
  private schedule(): void {
    if (this.debounce || this.closed) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.check();
    }, 150);
  }

  private findActiveFile(): string | null {
    if (!existsSync(this.logsDir)) return null;
    const candidates = readdirSync(this.logsDir).filter((f) => ACTIVE_RE.test(f)).sort();
    return candidates[candidates.length - 1] ?? null;
  }

  private check(): void {
    const latest = this.findActiveFile();
    if (latest && latest !== this.activeFile) {
      this.activeFile = latest;
      this.offset = 0;
      this.carry = "";
      this.events.onRotate?.(latest);
    }
    if (this.activeFile) this.readAppended();
  }

  private readAppended(): void {
    if (!this.activeFile) return;
    const path = join(this.logsDir, this.activeFile);
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return; // transient (rotation mid-flight)
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        // truncated/replaced in place — start over
        this.offset = 0;
        this.carry = "";
      }
      if (size === this.offset) return;
      const len = size - this.offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, this.offset);
      this.offset = size;
      const text = this.carry + buf.toString("utf-8");
      const lines = text.split("\n");
      this.carry = lines.pop() ?? "";   // last element is a partial line (or "")
      if (lines.length) this.events.onLines(lines, this.activeFile);
    } finally {
      closeSync(fd);
    }
  }
}
