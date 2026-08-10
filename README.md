# guildrun-compendium

[![release](https://img.shields.io/github/v/release/gdoteof/guildrun-compendium?label=companion&color=2a78d6)](https://github.com/gdoteof/guildrun-compendium/releases/latest)
[![license](https://img.shields.io/github/license/gdoteof/guildrun-compendium?color=52514e)](LICENSE)
[![site](https://img.shields.io/website?url=https%3A%2F%2Fguildrun.gd0t.com&label=compendium)](https://guildrun.gd0t.com)

Community stats compendium for [Guildrun](https://store.steampowered.com/app/4425970/) (Leyline).
Players opt in by dragging their game's log folder onto a web page (or running a small script);
the backend reconstructs their runs and derives tier rankings for heroes, items, and relics,
tracked against win rates.

Built on the extraction work in [guildrun-tools](https://github.com/gdoteof/guildrun-tools):
Guildrun logs every battle's **complete** starting state as JSON, so diffing consecutive battles
reconstructs everything that happened in the shop phase between them — even though the game
never logs a purchase directly.

## Architecture

Three layers, each rebuildable from the one below:

```
raw logs (R2, SteamIDs scrubbed at ingest)
  └─ facts (D1: runs, battles, exposures, acquisitions, shop phases)
       └─ aggregates (D1: shrunk win-rate-lift scores → tiers, per context)
            └─ read API + stats site   ← a future companion app consumes this same API
```

**Live:** https://guildrun.gd0t.com — drag your log
folder onto the home page, or run the script:

```bash
python3 tools/collect/collect.py            # autodetects Steam installs (Win/macOS/Linux/Proton)
```

Where the logs are:

| OS | path |
|---|---|
| Windows / Linux | `<game dir>/Guildrun_Data/Logs` |
| macOS | `<game dir>/Guildrun.app/Contents/Logs` (inside the bundle) |

macOS caveat: `~/Library/Logs/Leyline/Guildrun/Player.log` is Unity's console log and
contains none of the run data — the game's own logs are the dated `*-game*.log` files in
the bundle. Open that folder from Terminal (Finder won't descend into a bundle):

```bash
open "$HOME/Library/Application Support/Steam/steamapps/common/Guildrun Demo/Guildrun.app/Contents/Logs"
```

## Workspace

| path | what |
|---|---|
| `packages/parser` | TypeScript log parser + battle-diff (shop reconstruction) + SteamID scrubber. Pure functions — runs in Workers, Node, and later a companion app tailing live logs. |
| `packages/schema` | Shared types, D1 migrations. |
| `apps/worker` | Cloudflare Worker: upload API, parsing, aggregation cron, read API, site hosting. |
| `apps/companion` | Live companion: tails the game log, localhost UI with context-aware tier badges, and Niklas' Belly (what he ate, what it gave him) as a pop-out overlay over the game. See its README for the good-citizen resource contract. |
| `apps/overlay-macos` | Optional macOS HUD: an AppKit window around the companion's overlay page, so it floats over the game even in fullscreen. Not in the release yet (needs notarization). |
| `apps/overlay-linux` | The same HUD on Linux: a GTK/WebKitGTK window around the same page, X11 so it works under both X11 and Wayland sessions. Built from source (`./build.sh`), not in the release. |
| `apps/web` | Stats site (tier lists, entity pages, run replays, drag-and-drop upload). |
| `tools/collect` | Single-file stdlib-Python uploader for players who prefer a script. |
| `tools/catalog` | Content-catalog extractor (run by us per game version) + the Python reference parser. |
| `fixtures` | 13 real (SteamID-scrubbed) log files + golden outputs from the reference parser. |

## Golden-fixture parity

The TS parser is verified byte-identical (canonical serialization) to the Python reference
on all 13 fixture logs — 41 runs, 439 battles, 8 beaten — and the reference itself was
verified against the game's own save file. `pnpm test` runs the proof, including a
negative control and Python-compatible bankers rounding for battle durations.

```bash
pnpm install
pnpm test
```

## Ranking methodology

PvE has no head-to-head, so instead of literal Elo: per context (game version × difficulty ×
floor band), entity score = empirical-Bayes shrunk success rate `(wins + k·p0)/(n + k)` vs the
contextual baseline `p0`, tiered by lift quantiles, displayed with Wilson intervals and sample
sizes. Documented limits: shop offers are logged only as counts (except sale items), and
per-purchase prices are not recoverable.

## Privacy

Logs contain the player's SteamID in save-path lines. At ingest it is extracted for an
anonymous identity (HMAC with a server-side salt), then scrubbed from the raw text before
storage. No raw SteamID is stored or served. Extracted game text (the content catalog) is
seeded into the database at deploy time and never committed to this repo.

## License

MIT. Not affiliated with or endorsed by Leyline.
