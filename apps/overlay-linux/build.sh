#!/usr/bin/env bash
# Build the Linux overlay. One translation unit, system libraries only —
# no build system, matching the macOS target's no-Xcode-project spirit.
#
#   ./build.sh && ./build/guildrun-overlay
#
# Needs the WebKitGTK dev package:
#   Debian/Ubuntu  sudo apt install libwebkit2gtk-4.1-dev
#   Fedora         sudo dnf install webkit2gtk4.1-devel
#   Arch           sudo pacman -S webkit2gtk-4.1
set -euo pipefail

cd "$(dirname "$0")"

PKGS="gtk+-3.0 webkit2gtk-4.1"
if ! pkg-config --exists $PKGS; then
  echo "missing dev packages: $PKGS" >&2
  echo "see the header of this script for the install line on your distro" >&2
  exit 1
fi

mkdir -p build
gcc -O2 -Wall -Wextra -o build/guildrun-overlay src/main.c \
  $(pkg-config --cflags --libs $PKGS)

echo "built build/guildrun-overlay ($(du -h build/guildrun-overlay | cut -f1))"
