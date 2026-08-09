/**
 * Embed the UI pages into src/ui-embedded.ts.
 *
 * The compiled single-file binaries carry no files on disk, so each page in
 * ui/ ships as a string constant; dev runs still prefer the live file when one
 * is present (see CompanionServer.page).
 *
 * Stat icons are handled separately and only with --with-icons (which the
 * build:* scripts pass). They are extracted game art, which this repo does not
 * commit — same rule as apps/worker/public/icons, which the site deploys but
 * git never sees. So the committed ui-embedded.ts stays art-free, and the
 * icons are baked in at build time on a machine that has run
 * tools/catalog/guildrun_stat_icons.py. Without them the overlay simply shows
 * no glyphs.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const PAGES = [
  { file: "ui/index.html", constant: "UI_HTML" },
  { file: "ui/belly.html", constant: "BELLY_HTML" },
];

const ICONS = { file: "ui/stat-icons.css", constant: "STAT_ICONS_CSS" };

const withIcons = process.argv.includes("--with-icons");

const embed = ({ file, constant }, contents) =>
  `export const ${constant} = ${JSON.stringify(contents)};\n`;

let body = PAGES.map((p) => embed(p, readFileSync(p.file, "utf-8"))).join("\n");

if (withIcons && existsSync(ICONS.file)) {
  body += "\n" + embed(ICONS, readFileSync(ICONS.file, "utf-8"));
  console.log(`gen:ui: embedded ${ICONS.file}`);
} else {
  body += "\n" + embed(ICONS, "");
  if (withIcons) {
    console.warn(
      `gen:ui: ${ICONS.file} missing — building without stat icons.\n` +
      "        Generate them with: python3 tools/catalog/guildrun_stat_icons.py",
    );
  }
}

writeFileSync(
  "src/ui-embedded.ts",
  "// GENERATED from ui/ - regenerate with: pnpm gen:ui\n" +
  "// Embedded so compiled single-file binaries need no files on disk;\n" +
  "// dev runs still prefer the live files in ui/ when present.\n" +
  "// Stat icons are extracted game art: never committed, baked in only by\n" +
  "// the build:* scripts (pnpm gen:ui --with-icons).\n" +
  body,
);
