#!/bin/bash
# Pull upstream (kaceper11/monocode) changes into your fork's main, build a
# production MonoCode.app, and (with your confirmation) install it over
# /Applications/MonoCode.app.
#
# Usage: scripts/update-and-install.sh [--yes] [--clean]
#   --yes    skip the install confirmation prompt (install automatically)
#   --clean  wipe the whisper-rs-sys cmake build cache before building
#            (only needed if a build fails with a macOS-deployment-target
#            related C++ error — a stale cmake cache can otherwise linger
#            with the wrong flags)

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

AUTO_YES=false
CLEAN=false
for arg in "$@"; do
  case "$arg" in
    --yes) AUTO_YES=true ;;
    --clean) CLEAN=true ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

echo "==> Fetching upstream (kaceper11/monocode) and origin (your fork)"
git fetch upstream --quiet
git fetch origin --quiet

BRANCH="$(git branch --show-current)"
if [ "$BRANCH" != "main" ]; then
  echo "Refusing to run off branch '$BRANCH' — checkout main first." >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "You have uncommitted changes — commit or stash them first." >&2
  git status --short
  exit 1
fi

echo "==> Merging upstream/main into main"
if ! git merge upstream/main --no-edit; then
  echo
  echo "Merge conflict pulling in upstream. Resolve it manually, then commit" >&2
  echo "and re-run this script." >&2
  exit 1
fi

echo "==> Pushing updated main to your fork"
git push origin main

if [ "$CLEAN" = true ]; then
  echo "==> Clearing whisper-rs-sys cmake cache"
  rm -rf target/release/build/whisper-rs-sys-*
fi

echo "==> Installing npm dependencies"
npm install --no-audit --no-fund

echo "==> Building production app (this recompiles whisper.cpp — a few minutes)"
# --config points at a local, untracked override that raises the macOS
# deployment target — the vendored whisper.cpp fails to compile against
# Tauri's default (10.13) on current Xcode Command Line Tools. See
# src-tauri/tauri.local.conf.json.
npx tauri build --config src-tauri/tauri.local.conf.json

APP_SRC="target/release/bundle/macos/MonoCode.app"
if [ ! -d "$APP_SRC" ]; then
  echo "Build did not produce $APP_SRC — aborting install." >&2
  exit 1
fi

echo
echo "==> Build succeeded: $APP_SRC"

if [ "$AUTO_YES" != true ]; then
  read -r -p "Replace the installed /Applications/MonoCode.app with this build? [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Leaving the installed app untouched. Built app is at $APP_SRC."; exit 0 ;;
  esac
fi

echo "==> Quitting MonoCode if it's running"
osascript -e 'tell application "MonoCode" to quit' >/dev/null 2>&1 || true
sleep 2
pkill -f "/Applications/MonoCode.app/Contents/MacOS/monocode" >/dev/null 2>&1 || true
sleep 1

BACKUP_DIR="app-backups"
mkdir -p "$BACKUP_DIR"
if [ -d /Applications/MonoCode.app ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  echo "==> Backing up current install to $BACKUP_DIR/MonoCode-$STAMP.app"
  cp -R /Applications/MonoCode.app "$BACKUP_DIR/MonoCode-$STAMP.app"
  rm -rf /Applications/MonoCode.app
fi

echo "==> Installing new build"
cp -R "$APP_SRC" /Applications/MonoCode.app

NEW_SUM="$(shasum -a 256 "$APP_SRC/Contents/MacOS/monocode" | awk '{print $1}')"
INSTALLED_SUM="$(shasum -a 256 /Applications/MonoCode.app/Contents/MacOS/monocode | awk '{print $1}')"
if [ "$NEW_SUM" != "$INSTALLED_SUM" ]; then
  echo "Checksum mismatch after install — something went wrong." >&2
  exit 1
fi
echo "==> Verified: installed binary matches the build"

echo "==> Relaunching MonoCode"
open /Applications/MonoCode.app
echo "Done."
