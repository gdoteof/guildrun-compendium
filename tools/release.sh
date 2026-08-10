#!/usr/bin/env bash
# Cut a companion release: build all targets locally, checksum, publish to
# GitHub Releases. Deliberately NOT CI — bun cross-compiles every target from
# one machine, so releases cost zero runner minutes and work offline until the
# final `gh release create`.
#
#   tools/release.sh            # version from apps/companion/package.json
#   tools/release.sh --dry-run  # build + checksum only, no publish
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./apps/companion/package.json').version")
TAG="v${VERSION}"
DIST="apps/companion/dist"

echo "==> releasing guildrun-companion ${TAG}"

echo "==> tests"
pnpm --filter @guildrun/parser test >/dev/null
pnpm --filter @guildrun/companion test >/dev/null
pnpm -r typecheck >/dev/null
echo "    parser golden + companion tests + typecheck: OK"

echo "==> building all targets"
rm -rf "$DIST"
# --with-icons, like the build:* scripts: the stat glyphs are extracted game art
# that git never sees, so they are baked in here or not at all. gen:ui warns and
# carries on when they're missing, which is why this is easy to leave off — the
# release then silently ships a Belly overlay with no glyphs.
#
# src/ui-embedded.ts IS tracked, so --with-icons leaves ~45KB of game art in a
# committed file. Restore it as soon as the binaries are out, or the next
# `git commit -a` puts the art in the repo — exactly what .gitignore is keeping
# out. Trapped so a failed build cleans up too.
EMBEDDED="apps/companion/src/ui-embedded.ts"
restore_embedded() { git checkout -- "$EMBEDDED" 2>/dev/null || true; }
trap restore_embedded EXIT

(cd apps/companion \
  && pnpm gen:ui --with-icons \
  && bun build --compile --target=bun-linux-x64   src/index.ts --outfile dist/guildrun-companion-linux-x64 \
  && bun build --compile --target=bun-darwin-arm64 src/index.ts --outfile dist/guildrun-companion-macos-arm64 \
  && bun build --compile --target=bun-darwin-x64  src/index.ts --outfile dist/guildrun-companion-macos-x64 \
  && bun build --compile --target=bun-windows-x64 src/index.ts --outfile dist/guildrun-companion-windows-x64.exe)

restore_embedded

(cd "$DIST" && sha256sum guildrun-companion-* > SHA256SUMS)
ls -la "$DIST"

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "==> dry run: skipping tag + release"
  exit 0
fi

echo "==> tagging ${TAG} and publishing release"
git tag -f "$TAG"
git push -f origin "$TAG"
gh release create "$TAG" \
  "$DIST"/guildrun-companion-linux-x64 \
  "$DIST"/guildrun-companion-macos-arm64 \
  "$DIST"/guildrun-companion-macos-x64 \
  "$DIST"/guildrun-companion-windows-x64.exe \
  "$DIST"/SHA256SUMS \
  --title "guildrun-companion ${TAG}" \
  --notes-file RELEASE_NOTES.md
echo "==> done: https://github.com/gdoteof/guildrun-compendium/releases/tag/${TAG}"
