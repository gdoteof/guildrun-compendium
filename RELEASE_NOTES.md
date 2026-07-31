# guildrun-companion v0.3.0

macOS support that actually works. Single file, no install, no dependencies.

## New in 0.3.0

- **macOS: finds the real logs.** The game writes its structured logs *inside
  the app bundle* at `Guildrun.app/Contents/Logs` — not `Guildrun_Data/Logs`,
  and not Unity's `~/Library/Logs/Leyline/Guildrun/Player.log`, which contains
  no run data. The companion now resolves .app layouts, accepts a `.app` (or
  its Logs dir) for `--game-dir`, scans `~/Applications` and `/Applications`
  for non-Steam installs, and finds the macOS save dir — live overlay,
  run-save captures, and run-end uploads all work on Mac. (#1, #2)
- **Same-day restarts no longer bleed state.** NLog truncates the active log
  file in place when the game restarts within the same day; the tailer now
  treats that as a session rotation and resets the live view.

## What it does

- Tails Guildrun's own log live (event-driven, appended-bytes-only — measured
  0 idle CPU) and shows your run in a localhost page: party, items, relics,
  with **community tier badges for your current difficulty and floor**.
- Archives every distinct state of the in-progress Run save — which the game
  deletes at run end — capturing **full shop inventories with prices,
  including offers you rerolled past**, and event outcomes.
- At run end, uploads your log + captures to the
  [community compendium](https://guildrun-compendium.laxity-03-hunger3397.workers.dev)
  automatically (opt out with `--no-log-upload` / `--no-capture-upload`).

## Good-citizen contract

Zero CPU while idle, one timer total, reads only appended bytes, binds
127.0.0.1 only, <200KB disk cache, network limited to catalog(24h)/tiers(on
context change)/run-end uploads. Details + measurements in
[apps/companion/README](https://github.com/gdoteof/guildrun-compendium/tree/main/apps/companion).

## Run it

macOS (either chip; curl sidesteps Gatekeeper quarantine):

```bash
curl -fsSL "https://github.com/gdoteof/guildrun-compendium/releases/latest/download/guildrun-companion-macos-$(uname -m | sed 's/x86_64/x64/')" -o guildrun-companion \
  && chmod +x guildrun-companion && ./guildrun-companion
```

Linux:

```bash
curl -fsSL https://github.com/gdoteof/guildrun-compendium/releases/latest/download/guildrun-companion-linux-x64 -o guildrun-companion \
  && chmod +x guildrun-companion && ./guildrun-companion
```

Windows: download the `.exe` and run it (SmartScreen: "More info → Run anyway",
or verify against SHA256SUMS first). Then open http://127.0.0.1:4646/ and play —
the game is autodetected across Windows/Mac/Linux/Proton Steam installs
(`--game-dir` to point elsewhere, e.g. a CrossOver bottle).
