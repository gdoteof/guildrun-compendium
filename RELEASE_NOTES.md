# guildrun-companion v0.2.0

First public binary release. Single file, no install, no dependencies.

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
