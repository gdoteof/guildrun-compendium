# Guildrun Overlay (macOS)

Niklas' Belly as a **HUD drawn straight onto the game** — no window, no panel,
no chrome, just glyphs and numbers with the game visible through every gap.
Works when the game is in **macOS fullscreen**, which is the one case a browser
window cannot handle.

Drag it anywhere by grabbing it; it remembers where you left it.


## Why this exists

The companion's Belly page already pops out into Chrome's document
picture-in-picture window, which is always-on-top and costs no native code. But
always-on-top there means *within a Space*. macOS native fullscreen moves the
game into its own Space, and a window that hasn't opted into joining every Space
simply isn't there when you switch to it.

That opt-in is a window-server property with no web equivalent. So this target
is a window and nothing else — about 250 lines of AppKit around a `WKWebView`
pointed at the companion's own `/belly?overlay=1`. The belly logic, the layout,
the stat icons and the live SSE stream have exactly one implementation, in the
companion; this adds no second copy of any of it.

The four properties that do the work:

| property | why |
|---|---|
| `level = .screenSaver` (1000) | above normal and floating windows |
| `collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]` | rides into the game's fullscreen Space, without sliding during Space swaps |
| `.nonactivatingPanel` + `becomesKeyOnlyIfNeeded` | never takes focus or keystrokes from the game |
| `ignoresMouseEvents` | optional click-through, from the menu bar |

`isFloatingPanel`'s setter **forces the level back to `.floating` (3)**, so it is
set *before* the level, not after. Getting that backwards puts the panel below a
fullscreen game with no error anywhere — the app prints its effective level at
startup for exactly this reason, and it must read 1000:

```
$ ./.build/release/GuildrunOverlay
Guildrun Overlay
  level   1000 (expected 1000)
  spaces  canJoinAllSpaces=true
```

## Dragging a thing with no title bar

There's nothing to grab, so the **page** reports the drag: an injected script
claims left-presses on non-interactive content and posts to the native side,
which moves the window under the mouse until the button comes up. Scrolling,
hover and links keep working, because only those presses are claimed — which a
transparent catcher view over the web view would have swallowed wholesale.

Two things this needs that are easy to miss:

- `acceptsFirstMouse` on the web view. A view in an inactive window normally eats
  the first click just to activate; this overlay is *never* active (the game is),
  so without it the first grab of every drag would vanish.
- A **local** event monitor for the drag loop, not a global one — a non-activating
  panel still receives its own mouse events, and a global monitor would drag in an
  accessibility-permission prompt for no benefit.

## Legibility

A pure HUD has no backdrop, so the page carries a layered text shadow instead.
When a bright scene beats that, **Dim backdrop** in the menu adds a scrim — it's
a CSS class toggle, so the styling stays in one place.

The stat glyphs are the game's own, lifted from its `StatsIconAtlas`; see the
companion README.

## Build and run

```bash
swift build -c release                      # ~4s, no Xcode project
./.build/release/GuildrunOverlay            # needs the companion running
```

Flags: `--port <n>` `--url <url>` `--width <px>` `--height <px>` `--opacity <0-1>`

It's an **agent app** (`NSApplication.setActivationPolicy(.accessory)`): no Dock
icon, nothing to alt-tab into, just a 🍖 in the menu bar:

| menu item | |
|---|---|
| Hide overlay | park it without quitting |
| Click-through | stop taking mouse input entirely — clicks land on the game as if it weren't there (you can't drag it in this mode) |
| Dim backdrop | scrim behind the text for bright scenes |
| Opacity | 100 / 85 / 70 / 55% |
| Reload | if the companion restarted |

## What it does not do

No injection, no game files read or written, no accessibility or screen-recording
permissions, no global event taps. It renders a localhost page in a window. The
game is not aware it exists.

## Not in the release yet

This is deliberately outside `tools/release.sh`. Shipping it means **code signing
and notarization** — an unsigned overlay app is a considerably worse Gatekeeper
experience than an unsigned CLI, where `curl`-ing the binary sidesteps quarantine.
Until that's set up, it's a build-it-yourself extra.

A Windows equivalent would be the same idea with
`WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT`, and is not written.

## One hard limit

A game that takes the display outright with `CGDisplayCapture` cannot be drawn
over by anything. Unity doesn't do this on modern macOS, so Guildrun is fine.
