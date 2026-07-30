# Guildrun Companion

Live run overlay in your browser. Tails the game's own log file, keeps a live picture of
your run, and shows **community tier badges for your current context** (difficulty × floor
band) next to your party, items, relics, and shop sale offers.

No game files are modified, nothing is injected — the game already writes everything we
read.

## Run it

With Node (from the repo):

```bash
pnpm --filter @guildrun/companion start                # autodetect the game
pnpm --filter @guildrun/companion start -- --game-dir "<...>/Guildrun Demo/Guildrun_Data"
```

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
- Experimental: a shallow decode of the in-progress `Run` save (MessagePack), watched
  live — research toward reading the full shop inventory

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
