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

```
./guildrun-companion            # autodetects Steam installs (Win/Mac/Linux/Proton)
# then open http://127.0.0.1:4646/
```

macOS: browser downloads are quarantined — `xattr -d com.apple.quarantine <file>`,
or download with curl. Windows: SmartScreen will warn on an unsigned binary —
"More info → Run anyway", or verify against SHA256SUMS first.
