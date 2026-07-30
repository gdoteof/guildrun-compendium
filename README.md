# guildrun-compendium

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

## Workspace

| path | what |
|---|---|
| `packages/parser` | TypeScript log parser + battle-diff (shop reconstruction) + SteamID scrubber. Pure functions — runs in Workers, Node, and later a companion app tailing live logs. |
| `packages/schema` | Shared types, D1 migrations. |
| `apps/worker` | Cloudflare Worker: upload API, parsing, aggregation cron, read API, site hosting. |
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
