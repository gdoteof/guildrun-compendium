# Guildrun Overlay (Linux)

Niklas' Belly as a **HUD drawn straight onto the game** — no window, no panel,
no chrome, just glyphs and numbers with the game visible through every gap.

The Linux half of [`apps/overlay-macos`](../overlay-macos), and the same design:
this target is a *window* and nothing else. What it displays is the companion's
own `/belly?overlay=1` in a `WKWebView`'s GTK counterpart, so the belly logic,
the layout, the stat icons and the live SSE stream have exactly one
implementation — in the companion. Nothing here is a second copy of any of it.

Drag it anywhere by grabbing it; it remembers where you left it.


## Why this exists

The companion's Belly page already pops out into Chrome's document
picture-in-picture window, which costs no native code. On Linux its limit is
sharper than on macOS: **Wayland deliberately denies clients the two things a HUD
needs** — asking to stay on top, and placing themselves. That's not an oversight,
it's the security model.

The escape hatch is `wlr-layer-shell`, which sway, Hyprland and KDE implement and
**GNOME/Mutter does not** — so on the most common Linux gaming desktop there is no
Wayland answer at all. X11 has had one since 1997.

So this forces the GDK **X11** backend and runs as an X11 client. Under a Wayland
session that means XWayland, which is present everywhere and is where the game
itself already lands (Proton is XWayland; Unity's Linux player defaults to X11).
One code path, both session types.

The properties that do the work, next to their macOS counterparts:

| macOS | here |
|---|---|
| `level = .screenSaver` | `gtk_window_set_keep_above` → `_NET_WM_STATE_ABOVE` |
| `.canJoinAllSpaces`, `.stationary` | `gtk_window_stick` → `_NET_WM_STATE_STICKY` |
| `.nonactivatingPanel`, `becomesKeyOnlyIfNeeded` | `accept-focus = FALSE`, `_NET_WM_WINDOW_TYPE_UTILITY` |
| `ignoresMouseEvents` | empty X Shape **input region** |
| `drawsBackground = false` | RGBA visual + web view background alpha 0 |

It prints what it actually got, for the same reason the macOS target prints its
window level — these are invisible when they silently fail:

```
$ ./build/guildrun-overlay
Guildrun Overlay (Linux)
  backend x11
  above   yes   sticky, focusless, click-through off
```

`backend NOT X11` means something set `GDK_BACKEND=wayland`; keep-above will be
ignored and the overlay will behave like an ordinary window.

## What was measured

On Ubuntu 25.10, GNOME 49, Wayland session (so: XWayland), against a fullscreen
X11 window standing in for the game:

- the WM accepted `_NET_WM_STATE_ABOVE`, `_NET_WM_STATE_STICKY`, `SKIP_TASKBAR`,
  `SKIP_PAGER` and window type `UTILITY`;
- `_NET_CLIENT_LIST_STACKING` put the overlay **above the focused fullscreen
  window** — bottom to top: `Steam`, `STAND-IN GAME`, `Niklas' Belly`;
- pointer hit-testing at a point inside the overlay returned the overlay with
  click-through off, and **the fullscreen window underneath** with it on;
- dragging moved the window by exactly the pointer delta, and the position
  survived a restart;
- the tray icon embedded (`gtk_status_icon_is_embedded()` → true) under the
  stock Ubuntu AppIndicators extension.

Not verified here: how it looks composited over the real game. GNOME blocks
programmatic screenshots (`org.gnome.Shell.Screenshot` → `AccessDenied`), so
there is no capture of the two on screen together. The window is confirmed
depth-32 ARGB and the page paints on transparent, but the final "does it look
right over the game" is a one-look check.

## Dragging a thing with no title bar

There's nothing to grab, so the **page** reports the drag: an injected script
claims left-presses on non-interactive content and posts to the native side,
which then moves the window under the pointer until the button comes up.
Scrolling, hover and links keep working, because only those presses are claimed.

The script is character-for-character the one in the macOS target — WebKitGTK and
WKWebView expose the same `window.webkit.messageHandlers` API, so the page-side
contract is genuinely identical. Keep them in step.

The window is moved by hand rather than by `gtk_window_begin_move_drag`
(`_NET_WM_MOVERESIZE`), which is a *request* — and **Mutter declines it for this
window**. The message arrives with valid coordinates and the window simply does
not move; it is not the missing focus, which was ruled out by testing with
`accept-focus` on. Doing the arithmetic locally works on any WM and keeps
`accept-focus` off, which handing the drag to the WM would not.

## One page-level trap

WebKitGTK repaints a changed text node **without clearing under it** when the web
view background is transparent, so text edited *in place* stacks on its old
glyphs — the status line going from "connecting" to "live" renders as
"livenecting". Anything rebuilt through `innerHTML` repaints cleanly, which is
what makes it easy to miss.

`ui/belly.html` therefore hides the status *word* in overlay mode (the dot
already says it) and that is the only in-place text mutation on the page. If you
add another, expect to see it smear here and not on macOS.

## Build and run

```bash
./build.sh                      # one gcc line, system libraries only
./build/guildrun-overlay        # needs the companion running
```

Needs the WebKitGTK dev package — `libwebkit2gtk-4.1-dev` (Debian/Ubuntu),
`webkit2gtk4.1-devel` (Fedora), `webkit2gtk-4.1` (Arch). The runtime library
ships by default on GNOME and KDE desktops.

Flags: `--port <n>` `--url <url>` `--width <px>` `--height <px>` `--opacity <0-1>`
`--click-through`

## Menu and tray icon

The macOS target hangs its menu off an `NSStatusItem`. The same menu is here in
two places — **right-click the overlay**, or the **tray icon**:

| item | |
|---|---|
| Hide / Show overlay | park it without quitting |
| Pass clicks through to the game | stop taking mouse input entirely — clicks land on the game as if it weren't there |
| Dim backdrop | scrim behind the text for bright scenes (a CSS class toggle, so the styling stays in the page) |
| Opacity | 100 / 85 / 70 / 55% |
| Reload | if the companion restarted |
| Quit | |

**Passing clicks through is a one-way door from the overlay's side** — once it's
on, there is nothing left to right-click. So it always leaves two ways back:

- **click the tray icon** (left click toggles it — that is the whole reason the
  icon exists, so it is the panic button rather than a menu opener), and
- `kill -USR1 $(pgrep -f guildrun-overlay)`, printed with the pid at startup.

Turning it on also says which of those applies, on the page, for six seconds —
being told after you can no longer click anything is no use.

The icon is a `GtkStatusIcon`. That is deprecated in GTK3 with no GTK4 successor,
but it is what works across these desktops without making
`libayatana-appindicator` a build dependency: GNOME shows it through the
AppIndicator extension (**default on Ubuntu**, verified working on GNOME 49),
and KDE/XFCE/Cinnamon/MATE have a tray natively. Where nothing hosts it, startup
says so and `SIGUSR1` is the way back:

```
  tray    no host for a tray icon on this desktop —
          kill -USR1 12345 is the way back from click-through
```

Menu toggles are checkboxes, not labels that read like instructions — "Click-through:
off" is ambiguous about whether it reports or commands, and gets clicked by people
who wanted it off.

## What it does not do

No injection, no game files read or written, no X input grabs, no screen capture,
no accessibility permissions. It renders a localhost page in a window. The game is
not aware it exists.

## Not in the release

Deliberately outside `tools/release.sh`, like the macOS overlay. This one links
against the system WebKitGTK, so a prebuilt binary would be hostage to the
distro's library version — `./build.sh` takes about a second and is honest.

## Limits

- **Wayland-native sessions with no XWayland** — nothing to be done; the overlay
  says so at startup rather than appearing to work.
- **GNOME has no `wlr-layer-shell`**, so this cannot become a Wayland-native
  client there. On sway/Hyprland/KDE a layer-shell version would be strictly
  better, and this one still works through XWayland in the meantime.
- A game that takes the display outright (`DRM master`, exclusive fullscreen)
  cannot be drawn over by anything. Unity's Linux player doesn't do this.
