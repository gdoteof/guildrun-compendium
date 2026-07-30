/**
 * Upload ingestion: multipart files → scrub SteamIDs → content-hash →
 * raw store → parse → facts. Synchronous parse so the response can say
 * "found N runs"; aggregation refresh rides on waitUntil.
 */

import { extractSteamIds, scrubSteamIds, PARSER_VERSION, type LogFile } from "@guildrun/parser";
import { type Env, sha256Hex, playerHash } from "./env.js";
import type { RawStore } from "./storage.js";
import { parseFiles, insertFacts, heroNameMap } from "./facts.js";

export interface UploadResult {
  status: number;
  body: Record<string, unknown>;
}

const BUILD_GUID_RE = /build-guid=([0-9a-f]{32})/;

export async function resolveGameVersion(db: D1Database, buildGuid: string | null): Promise<number> {
  if (!buildGuid) return 0;
  const existing = await db
    .prepare("SELECT id FROM game_version WHERE build_guid = ?")
    .bind(buildGuid)
    .first<{ id: number }>();
  if (existing) return existing.id;
  const row = await db
    .prepare("INSERT INTO game_version (build_guid, label, first_seen) VALUES (?,?,?) RETURNING id")
    .bind(buildGuid, buildGuid.slice(0, 8), new Date().toISOString())
    .first<{ id: number }>();
  return row!.id;
}

export async function handleUpload(env: Env, store: RawStore, form: FormData): Promise<UploadResult> {
  const maxFiles = parseInt(env.MAX_FILES, 10);
  const maxBytes = parseInt(env.MAX_FILE_BYTES, 10);

  // workers-types FormData.getAll is typed string[]; runtime values for file
  // parts are File objects — use a structural guard rather than instanceof
  const isFilePart = (f: unknown): f is { name: string; size: number; text(): Promise<string> } =>
    typeof f === "object" && f !== null && "size" in f && "name" in f &&
    typeof (f as { text?: unknown }).text === "function";
  const entries = (form.getAll("files") as unknown[]).filter(isFilePart);
  if (!entries.length) return { status: 400, body: { error: "no files" } };
  if (entries.length > maxFiles) return { status: 400, body: { error: `too many files (max ${maxFiles})` } };

  let buildGuid: string | null = null;
  const logFiles: { name: string; text: string }[] = [];
  const steamIds = new Set<string>();

  for (const f of entries) {
    if (f.size > maxBytes) return { status: 400, body: { error: `${f.name} too large` } };
    const text = await f.text();
    const base = f.name.split("/").pop()!.split("\\").pop()!;
    if (base === "boot.config") {
      buildGuid = BUILD_GUID_RE.exec(text)?.[1] ?? null;
      continue;
    }
    if (!base.endsWith(".log")) continue;
    for (const id of extractSteamIds(text)) steamIds.add(id);
    logFiles.push({ name: base, text: scrubSteamIds(text) });
  }
  if (!logFiles.length) return { status: 400, body: { error: "no .log files found" } };

  const playerId = steamIds.size
    ? await playerHash(env.HMAC_SALT ?? "dev-salt-not-for-production", [...steamIds].sort()[0]!)
    : null;

  // content-addressed raw storage; upload identity = hash of the file-hash set
  const withHashes: (LogFile & { hash: string; size: number })[] = [];
  for (const f of logFiles) {
    withHashes.push({ ...f, hash: await sha256Hex(f.text), size: f.text.length });
  }
  const contentHash = await sha256Hex(withHashes.map((f) => f.hash).sort().join("\n"));

  const dup = await env.DB
    .prepare("SELECT id, runs_found, runs_inserted FROM upload WHERE content_hash = ?")
    .bind(contentHash)
    .first<{ id: string; runs_found: number; runs_inserted: number }>();
  if (dup) {
    return {
      status: 200,
      body: { duplicate: true, upload_id: dup.id, runs_found: dup.runs_found, runs_inserted: 0 },
    };
  }

  const uploadId = crypto.randomUUID();
  const now = new Date().toISOString();
  const gameVersionId = await resolveGameVersion(env.DB, buildGuid);

  if (playerId) {
    await env.DB
      .prepare("INSERT OR IGNORE INTO player (id, first_seen) VALUES (?,?)")
      .bind(playerId, now)
      .run();
  }
  await env.DB
    .prepare(
      `INSERT INTO upload (id, content_hash, player_id, received_at, build_guid,
         parser_version, status, file_count) VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind(uploadId, contentHash, playerId, now, buildGuid, PARSER_VERSION, "received", withHashes.length)
    .run();

  for (const f of withHashes) {
    await store.put(f.hash, f.text);
    await env.DB
      .prepare("INSERT OR IGNORE INTO upload_file (upload_id, file_hash, name, size) VALUES (?,?,?,?)")
      .bind(uploadId, f.hash, f.name, f.size)
      .run();
  }

  try {
    const runs = parseFiles(withHashes);
    const names = await heroNameMap(env.DB);
    const summary = await insertFacts(env.DB, uploadId, playerId, gameVersionId, runs, names);
    await backfillFromCaptures(env.DB);
    await env.DB
      .prepare("UPDATE upload SET status = 'parsed', runs_found = ?, runs_inserted = ? WHERE id = ?")
      .bind(summary.runsFound, summary.runsInserted + summary.runsReplaced, uploadId)
      .run();
    return {
      status: 200,
      body: {
        upload_id: uploadId,
        files: withHashes.length,
        runs_found: summary.runsFound,
        runs_inserted: summary.runsInserted,
        runs_replaced: summary.runsReplaced,
        runs_skipped_duplicate: summary.runsSkipped,
      },
    };
  } catch (err) {
    await env.DB
      .prepare("UPDATE upload SET status = 'failed', error = ? WHERE id = ?")
      .bind(String(err), uploadId)
      .run();
    return { status: 500, body: { error: "parse failed", upload_id: uploadId, detail: String(err) } };
  }
}

/** Runs can arrive AFTER their captures (logs are uploaded later than the
 * run-end capture push) — pull true difficulty onto any run that matches an
 * already-ingested capture by (player, seed). */
export async function backfillFromCaptures(db: D1Database): Promise<void> {
  await db.prepare(
    `UPDATE run SET
       difficulty_index = COALESCE(difficulty_index,
         (SELECT c.difficulty_index FROM capture c
          WHERE c.player_id IS run.player_id AND c.run_seed IS run.seed
            AND c.difficulty_index IS NOT NULL LIMIT 1)),
       is_challenge = COALESCE(is_challenge,
         (SELECT c.is_challenge FROM capture c
          WHERE c.player_id IS run.player_id AND c.run_seed IS run.seed LIMIT 1)),
       run_guid = COALESCE(run_guid,
         (SELECT c.run_guid FROM capture c
          WHERE c.player_id IS run.player_id AND c.run_seed IS run.seed
            AND c.run_guid IS NOT NULL LIMIT 1))
     WHERE seed IS NOT NULL AND (difficulty_index IS NULL OR run_guid IS NULL)`,
  ).run();
}

/** Re-parse every stored raw file grouped by upload — run after parser upgrades. */
export async function reparseAll(env: Env, store: RawStore): Promise<Record<string, unknown>> {
  const uploads = await env.DB
    .prepare("SELECT id, player_id, build_guid FROM upload WHERE status != 'failed'")
    .all<{ id: string; player_id: string | null; build_guid: string | null }>();
  const names = await heroNameMap(env.DB);
  const { deleteFactsForUpload } = await import("./facts.js");

  let reparsed = 0;
  for (const up of uploads.results) {
    const files = await env.DB
      .prepare("SELECT file_hash, name FROM upload_file WHERE upload_id = ?")
      .bind(up.id)
      .all<{ file_hash: string; name: string }>();
    const logFiles: LogFile[] = [];
    for (const f of files.results) {
      const text = await store.get(f.file_hash);
      if (text !== null) logFiles.push({ name: f.name, text });
    }
    if (!logFiles.length) continue;
    await deleteFactsForUpload(env.DB, up.id);
    const gameVersionId = await resolveGameVersion(env.DB, up.build_guid);
    const runs = parseFiles(logFiles);
    const summary = await insertFacts(env.DB, up.id, up.player_id, gameVersionId, runs, names);
    await env.DB
      .prepare("UPDATE upload SET status = 'parsed', parser_version = ?, runs_found = ?, runs_inserted = ? WHERE id = ?")
      .bind(PARSER_VERSION, summary.runsFound, summary.runsInserted, up.id)
      .run();
    reparsed++;
  }
  return { uploads_reparsed: reparsed, parser_version: PARSER_VERSION };
}
