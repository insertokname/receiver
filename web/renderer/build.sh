#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Builds the web app (Desktop's main window for the browser) into
# web/dist/app/. Runs Desktop's own generators first (protobuf code, emoji
# data, compiled stylesheets, compact locales; all git-ignored outputs inside
# the repository), then bundles with renderer/build.mjs.
#
# Needs Desktop's dependencies at the repository root
# (pnpm install --frozen-lockfile --ignore-scripts) and web/'s own.
#
# Usage: renderer/build.sh [build.mjs options, e.g. --no-minify]
set -euo pipefail

WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$WEB/.." && pwd)"

if [ ! -d "$REPO/node_modules/react" ]; then
  echo "Desktop dependencies missing: run pnpm install --frozen-lockfile --ignore-scripts at the repository root" >&2
  exit 1
fi
if [ ! -f "$WEB/libsignal/dist/package/wasm/libsignal_node.wasm" ]; then
  echo "libsignal not built: run web/libsignal/build.sh first" >&2
  exit 1
fi

(
  cd "$REPO"
  for script in build:protobuf build:emoji-data build:compact-locales build:styles:prod; do
    pnpm run --silent "$script"
  done
)

node "$WEB/renderer/build.mjs" "$@"
