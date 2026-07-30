# Releasing

Releases are **built locally and published with `gh`** — deliberately no CI.
Bun cross-compiles every target from one machine, so a release costs zero
runner minutes; GitHub Releases are just tags plus uploaded assets, and the
`gh` CLI creates them first-class.

## Procedure

1. Bump `apps/companion/package.json` `version` (it feeds `--version`, the UI
   footer, and the tag).
2. Update `RELEASE_NOTES.md` with what changed.
3. Run:

```bash
tools/release.sh --dry-run   # tests + build all four targets + checksums
tools/release.sh             # same, then tag v<version> and publish
```

The script refuses to publish if the parser golden tests, companion tests, or
typechecks fail. Assets: `guildrun-companion-{linux-x64,macos-arm64,macos-x64,windows-x64.exe}`
plus `SHA256SUMS`.

## Stable download URLs

`releases/latest/download/<asset>` always points at the newest release — the
website's download buttons use these and never need updating:

```
https://github.com/gdoteof/guildrun-compendium/releases/latest/download/guildrun-companion-linux-x64
```

## Versioning

Semver on the companion (`v0.x.y` tags, repo-wide). `@guildrun/parser` carries
its own `PARSER_VERSION`, stamped onto uploads/facts so the server knows which
parser produced what — bump it whenever parser behavior changes (golden
fixtures pin it honest).
