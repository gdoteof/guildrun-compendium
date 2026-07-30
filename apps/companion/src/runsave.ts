/**
 * Experimental: watch the in-progress `Run` save (MessagePack, sibling of the
 * Profile save). The game rewrites it constantly during a run and deletes it
 * when the run ends. We decode best-effort and surface a shallow summary —
 * primarily to research whether it carries the live shop inventory (the one
 * thing the logs never name). Watching is event-driven and the file is a few
 * KB, so the cost is negligible; failures are silently tolerated.
 */

import { readFileSync, watch, existsSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { decode } from "@msgpack/msgpack";

export interface RunSaveSummary {
  present: boolean;
  decoded: boolean;
  updated_at: string | null;
  /** shallow view: top-level keys with scalar values or child-key lists */
  overview: Record<string, unknown> | null;
}

export class RunSaveWatcher {
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private summary: RunSaveSummary = {
    present: false, decoded: false, updated_at: null, overview: null,
  };

  constructor(
    private saveDir: string,
    private onChange: () => void,
  ) {}

  start(): void {
    this.readOnce();
    try {
      this.watcher = watch(this.saveDir, () => {
        if (this.debounce) return;
        this.debounce = setTimeout(() => {
          this.debounce = null;
          this.readOnce();
          this.onChange();
        }, 250);
      });
      this.watcher.on("error", () => { /* save watching is best-effort */ });
    } catch { /* dir unwatchable: keep last summary */ }
  }

  stop(): void {
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
  }

  current(): RunSaveSummary {
    return this.summary;
  }

  private readOnce(): void {
    const path = join(this.saveDir, "Run");
    if (!existsSync(path)) {
      this.summary = { present: false, decoded: false, updated_at: null, overview: null };
      return;
    }
    try {
      const data = decode(readFileSync(path)) as Record<string, unknown>;
      this.summary = {
        present: true,
        decoded: true,
        updated_at: new Date().toISOString(),
        overview: shallow(data),
      };
    } catch {
      this.summary = {
        present: true, decoded: false, updated_at: new Date().toISOString(), overview: null,
      };
    }
  }
}

/** One level deep: scalars verbatim, containers as a shape descriptor. */
function shallow(obj: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || typeof v !== "object") {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = depth < 1 && v.length && typeof v[0] === "object" && v[0] !== null
        ? { $array: v.length, sample: shallow(v[0] as Record<string, unknown>, depth + 1) }
        : { $array: v.length };
    } else {
      out[k] = depth < 1
        ? shallow(v as Record<string, unknown>, depth + 1)
        : { $keys: Object.keys(v as object).slice(0, 20) };
    }
  }
  return out;
}
