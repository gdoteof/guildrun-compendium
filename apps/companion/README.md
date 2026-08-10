# Guildrun Companion

Live run overlay in your browser. Tails the game's own log file, keeps a live picture of
your run, and shows **community tier badges for your current context** (difficulty × floor
band) next to your party, items, relics, and shop sale offers.

No game files are modified, nothing is injected — the game already writes everything we
read.

## Install

Grab a single-file binary from the
[latest release](https://github.com/gdoteof/guildrun-compendium/releases/latest) —
no runtime, no installer:

| platform | download |
|---|---|
| Windows x64 | [guildrun-companion-windows-x64.exe](https://github.com/gdoteof/guildrun-compendium/releases/latest/download/guildrun-companion-windows-x64.exe) |
| macOS Apple Silicon | [guildrun-companion-macos-arm64](https://github.com/gdoteof/guildrun-compendium/releases/latest/download/guildrun-companion-macos-arm64) |
| macOS Intel | [guildrun-companion-macos-x64](https://github.com/gdoteof/guildrun-compendium/releases/latest/download/guildrun-companion-macos-x64) |
| Linux x64 | [guildrun-companion-linux-x64](https://github.com/gdoteof/guildrun-compendium/releases/latest/download/guildrun-companion-linux-x64) |

Verify with [SHA256SUMS](https://github.com/gdoteof/guildrun-compendium/releases/latest/download/SHA256SUMS).
Releases are built locally and published with `gh` — see [RELEASING.md](../../RELEASING.md).

One-liners — macOS (either chip; curl also sidesteps Gatekeeper quarantine):

```bash
curl -fsSL "https://github.com/gdoteof/guildrun-compendium/releases/latest/download/guildrun-companion-macos-$(uname -m | sed 's/x86_64/x64/')" -o guildrun-companion \
  && chmod +x guildrun-companion && ./guildrun-companion
```

Linux:

```bash
curl -fsSL https://github.com/gdoteof/guildrun-compendium/releases/latest/download/guildrun-companion-linux-x64 -o guildrun-companion \
  && chmod +x guildrun-companion && ./guildrun-companion
```

Then open http://127.0.0.1:4646/ and play.

## Run it

With Node (from the repo):

```bash
pnpm --filter @guildrun/companion start                # autodetect the game
pnpm --filter @guildrun/companion start -- --game-dir "<...>/Guildrun Demo/Guildrun_Data"
pnpm --filter @guildrun/companion start -- --game-dir "<...>/Guildrun Demo"   # macOS: holds Guildrun.app
```

`--game-dir` accepts the game folder, `Guildrun_Data`, a macOS `.app` bundle, or the `Logs`
directory itself. On macOS the logs live at `Guildrun.app/Contents/Logs` — Unity's
`~/Library/Logs/Leyline/Guildrun/Player.log` is a different file with no run data in it.

Then open http://127.0.0.1:4646/ — a second monitor, or another device on your LAN if you
pass `--host 0.0.0.0`.

Standalone binaries (no Node needed) — built with `bun build --compile`:

```bash
pnpm --filter @guildrun/companion build:linux   # or build:mac / build:win
```

Cross-compiling all three targets works from any one machine. The binaries are ~95MB
(embedded runtime) — the one-time disk cost of "download one file and run it".

Flags: `--game-dir <path>` `--port <n>` `--host <addr>` `--server <url>` `--no-save-watch`

## Good-citizen contract

This runs on someone else's machine, so the resource budget is a contract, not an
aspiration — and it's measured, not estimated:

| resource | behavior | measured |
|---|---|---|
| CPU (idle) | event-driven `fs.watch`; no polling loops | **0 jiffies over 10s** |
| CPU (playing) | reads only *appended* bytes at a tracked offset; 150ms burst coalescing; parsing is incremental (`RunAssembler.feed`), never a re-parse | one positioned read + a few regex per log burst |
| memory | bounded: current session's runs only | ~50MB RSS (plain node) |
| network | catalog once per 24h (disk-cached); tiers only on context change, 5-min floor; offline degrades to cached data | a few KB per floor |
| disk | one cache file (<200KB) in the platform config dir (`~/.config` / `Application Support` / `%APPDATA%`) | |
| timers | exactly one: a 25s SSE keepalive (unref'd) | |
| server | binds `127.0.0.1` unless you opt into `--host` | |

The UI receives pushes over Server-Sent Events — neither side polls. Watch-API failure
(network drives, exotic mounts) degrades to a lazy 5-second stat poll of a single file,
announced on stderr.

## What it shows

- Run context: difficulty, floor, W–L, shards (as of last battle), lives
- Party with rank, items, and tier badges for your current context
- Relics with tier badges
- When a shop is open: **sale offers by name with tier badges** (sales are the only
  offers the game logs by name)
- **Niklas' Belly** — every item Niklas has eaten this run, the stats each one gave him
  permanently, and the running total ([details](#niklas-belly))
- Experimental: a shallow decode of the in-progress `Run` save (MessagePack), watched
  live — research toward reading the full shop inventory

## Niklas' Belly

<a id="niklas-belly"></a>Niklas' passive, Red Hot Deals:

> When Niklas **survives** combat, consume the item in his left-most item slot.
> Permanently gain 100% of its stats and gain Shards equal to 80% its value.

Which is a great mechanic and an awful thing to keep track of in your head — six floors
in, "what am I actually made of now?" has no answer in the game's UI beyond a counter.
So: http://127.0.0.1:4646/belly lists every item he has eaten, what each one gave him,
and the totals.

Nothing about the consumption is logged directly. It's reconstructed the same way shop
purchases are — by diffing what the game *does* log every battle:

| field | what it tells us |
|---|---|
| `PermanentCustomData.niklasItemsConsumedCount` | he ate, and how many |
| his `EquippedItems` **in the battle he survived** | *which* item (left-most non-empty slot — the shop can reshuffle his bags afterwards, so it has to be read from the battle before) |
| `StatModifications` (append-only) | the stats actually granted |
| `PermanentCustomData.customDataTracking2` | shards the passive has generated |

The catalog decides *which* logged entries belong to the eaten item; the **log** decides
how much they were worth. That distinction matters, because an item does not always
grant what it prints:

- **Deadeye Hood** triples its own stats when its holder is alone in the back row
- **Assassin's Hood** accumulates +4 Crit per kill

Eat one of those in its pumped state and the game grants the pumped amount — so the
belly shows `+60 Attack Speed ×3` (hover for the printed value), not the base 20. Exact
matches are claimed first, which keeps an unrelated same-stat gain in the same battle
from being mistaken for an amplified one; anything left over is reported as coming from
another source (rank modifier, relic, event) rather than credited to the belly.

Verified against every consumption in the fixture logs
(`packages/parser/test/belly.test.ts`) — including one battle where an unrelated
+25 Attack Speed arrived alongside a bite and stayed out of it. With no catalog
reachable it falls back to crediting the logged delta as-is.

One quirk worth knowing: a bite is only visible in the *next* battle's logged state, so
the newest one appears when the following battle starts.

### As an overlay

Two ways, both showing the same page.

**In the browser** — **Pop out overlay**, top right — uses the document
Picture-in-Picture window: no native code, no extra process, and the floating panel is
the same live DOM node moved across, so it rides the one existing SSE stream. Chrome/Edge
(116+) have the API; Firefox and Safari fall back to a plain popup.

Its limits are the OS's, not the page's. Always-on-top means *within a Space*, so it
can't follow a game into **macOS fullscreen**; windowed or borderless is fine. On
**Wayland** it's weaker still — clients simply may not ask to stay on top, and GNOME has
no `wlr-layer-shell` to ask through instead.

**As a real HUD** — a thin native window around this same `/belly?overlay=1`. No panel,
no chrome, drag it anywhere. Still no injection and no game files touched:

| | |
|---|---|
| [`apps/overlay-macos`](../overlay-macos) | ~300 lines of AppKit around a `WKWebView`. Follows the game into fullscreen. |
| [`apps/overlay-linux`](../overlay-linux) | ~350 lines of GTK around a `WebKitGTK` view. Runs as an X11 client, so it works in **both X11 and Wayland sessions** (through XWayland, where the game already is). Tray icon for the menu. |

Both are built from source and are outside `tools/release.sh`; see their READMEs.
Neither contains a second copy of the belly logic — they are windows.

`/belly?overlay=1` is also just the compact skin, for a second monitor or a tablet on the
LAN (`--host 0.0.0.0`).

The overlay costs no extra resources: same tail, same state, one more page.

### Stat icons

The overlay labels stats with the game's own glyphs, sliced out of its `StatsIconAtlas`
(the sprites behind the `<maxhp>`/`<crit>` markup in its descriptions) and embedded as
data URIs, since the companion ships as one self-contained binary:

```bash
python3 tools/catalog/guildrun_stat_icons.py     # writes ui/stat-icons.css
```

Like all extracted game art in this repo, that file is **not committed** — the build
scripts bake it in (`pnpm gen:ui --with-icons`) on a machine that has run the extractor.
Without it the page renders fine, just with no glyphs.

## Platform notes

- **Windows**: autodetects Steam library layouts; save dir at
  `%USERPROFILE%/AppData/LocalLow/Leyline/Guildrun/Saves`.
- **Linux (Proton)**: autodetects snap/flatpak/native Steam and the compatdata prefix for
  the save dir.
- **macOS**: autodetects `~/Library/Application Support/Steam`. If you play through
  CrossOver/Whisky, pass `--game-dir` at the bottle's game folder. If you downloaded the
  binary through a browser, macOS quarantines it — `xattr -d com.apple.quarantine <file>`
  or fetch it with `curl` instead.

## Run as a service (Linux, systemd user unit)

The companion is service-shaped by design: clean SIGTERM shutdown, stdout logging
(journald), no interactivity, memory bounded (state resets on daily log rotation), and
0 idle CPU — running it permanently costs nothing while the game is closed.

```bash
install -m 755 dist/guildrun-companion-linux-x64 ~/.local/bin/guildrun-companion
cp contrib/guildrun-companion.service ~/.config/systemd/user/   # edit --game-dir
systemctl --user daemon-reload
systemctl --user enable --now guildrun-companion
```

The shipped unit includes hard resource ceilings (MemoryMax=300M, CPUQuota=50%) and a
read-only filesystem sandbox (`ProtectHome=read-only` + write access only to its own
config dir) — belt and braces on top of the app's own budget. Starts at login; the
game needs a login session anyway. macOS equivalent would be a LaunchAgent plist;
Windows a Scheduled Task at logon — same binary, no code changes.
