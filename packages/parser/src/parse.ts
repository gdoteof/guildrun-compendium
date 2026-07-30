/**
 * Guildrun log parser — batch entry point.
 *
 * Tokenizes log text into records and feeds them, timestamp-sorted, through a
 * single RunAssembler (see assembler.ts, where the actual state machine — a
 * faithful port of the Python reference parser — lives). Golden-fixture tests
 * compare the full output structurally against the reference on 13 real log
 * files, so any behavioral drift fails CI.
 */

import type { LogRecord, ParseResult } from "./types.js";
import { RunAssembler } from "./assembler.js";

const LINE_RE =
  /^\[(?<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\] \[(?<level>[A-Z]+)\] \[(?<src>[^\]]+)\] (?:\[(?<method>[A-Za-z_0-9]+):(?<srcline>\d+)\] )?(?<msg>.*)$/;

/** Tokenize raw log text into structured records (continuation lines of
 * multi-line messages don't match and are skipped, as in the reference). */
export function parseLines(text: string, fileName: string): LogRecord[] {
  const records: LogRecord[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const m = LINE_RE.exec(line);
    if (!m?.groups) continue;
    records.push({
      ts: m.groups["ts"]!,
      level: m.groups["level"]!,
      src: m.groups["src"]!,
      method: m.groups["method"] ?? null,
      srcline: m.groups["srcline"] ?? null,
      msg: m.groups["msg"]!.replace(/\s+$/, ""),
      file: fileName,
    });
  }
  return records;
}

/** Parse a single line; null if it isn't a log record (continuation line). */
export function parseLine(line: string, fileName: string): LogRecord | null {
  const records = parseLines(line, fileName);
  return records[0] ?? null;
}

export interface LogFile {
  name: string;
  text: string;
}

export function parseGuildrunLogs(files: LogFile[]): ParseResult {
  const records: LogRecord[] = [];
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    records.push(...parseLines(f.text, f.name));
  }
  // stable sort by timestamp string (lexicographic == chronological)
  records.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const assembler = new RunAssembler();
  for (const r of records) assembler.feed(r);
  assembler.finish();

  return {
    runs: assembler.runs,
    sessions: assembler.sessions,
    recordCount: assembler.recordCount,
  };
}
