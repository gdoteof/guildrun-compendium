# guildrun-companion v0.4.0

Niklas' Belly: what he ate, and what it actually gave him — as a HUD over the
game. Single file, no install, no dependencies.

## New in 0.4.0

- **Niklas' Belly.** His passive eats his left-most item after every combat he
  survives and keeps its stats permanently, and the game gives you a counter and
  nothing else. `http://127.0.0.1:4646/belly` lists every item he has eaten, the
  stats each one granted, the running totals, and the shards the passive
  generated — labelled with the game's own stat glyphs.

  Nothing logs the consumption, so it's reconstructed the way shop purchases
  already are, from what every battle *does* log about him: the meal counter,
  his equipped items in the battle he survived, and the permanent stat grants
  appended that battle.

  The catalog decides *which* logged gains belong to the eaten item; the **log**
  decides how much they were worth. That matters because items don't always
  grant what they print — eat a **Deadeye Hood** while its holder is alone in the
  back row and it grants its tripled stats, so the belly reports `+60 Attack
  Speed ×3`, not the base 20. Unrelated gains that land in the same battle are
  reported separately rather than credited to him.

- **The Belly as an overlay over the game.** **Pop out overlay** on that page
  uses the browser's document Picture-in-Picture window — no native code, no
  extra process, and the floating panel is the same live DOM node, so it rides
  the one existing event stream.

  For the cases a browser window can't reach, there are two small native HUDs
  around that same page — no panel, no chrome, drag them anywhere:

  | | |
  |---|---|
  | `apps/overlay-macos` | AppKit + `WKWebView`. Follows the game into **macOS fullscreen**, which a browser window cannot do — always-on-top there means *within a Space*. |
  | `apps/overlay-linux` | GTK + WebKitGTK. Runs as an X11 client, so it works in **both X11 and Wayland sessions** — Wayland gives clients no way to stay on top, and GNOME has no `wlr-layer-shell` to ask through. Tray icon for the menu. |

  Both are built from source and are **not** in this release — see their READMEs.
  Neither contains a second copy of the belly logic; they are windows.

- **`guildrun.gd0t.com`** is now the compendium's address, and what this binary
  uploads to. The old `workers.dev` hostname stays live so binaries ≤ v0.3.0
  keep working.

## Fixed

- A stat the catalog has no name for (which it prints as `Stat<n>`) was credited
  to a bite at its *printed* value while the real logged gain fell through into
  "other sources" — one grant reported twice. Not reachable on the current game
  version; silent the day the game adds a stat.

## What it does

- Tails Guildrun's own log live (event-driven, appended-bytes-only — measured
  0 idle CPU) and shows your run in a localhost page: party, items, relics,
  with **community tier badges for your current difficulty and floor**.
- Archives every distinct state of the in-progress Run save — which the game
  deletes at run end — capturing **full shop inventories with prices,
  including offers you rerolled past**, and event outcomes.
- At run end, uploads your log + captures to the
  [community compendium](https://guildrun.gd0t.com)
  automatically (opt out with `--no-log-upload` / `--no-capture-upload`).

## Good-citizen contract

Zero CPU while the game is idle; parsing touches only appended bytes; network is
the catalog once a day plus tier lookups when your run's context changes; disk is
a <200KB cache in your platform's config dir. No game files are modified, nothing
is injected — the game already writes everything this reads.

## Install

Download for your platform below, or:

```bash
# macOS (either chip; curl also sidesteps Gatekeeper quarantine)
curl -fsSL "https://github.com/gdoteof/guildrun-compendium/releases/latest/download/guildrun-companion-macos-$(uname -m | sed 's/x86_64/x64/')" \
  -o guildrun-companion && chmod +x guildrun-companion && ./guildrun-companion

# Linux
curl -fsSL https://github.com/gdoteof/guildrun-compendium/releases/latest/download/guildrun-companion-linux-x64 \
  -o guildrun-companion && chmod +x guildrun-companion && ./guildrun-companion
```

Then play, and open <http://127.0.0.1:4646/>. Verify with `SHA256SUMS`.
