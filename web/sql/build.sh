#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Prepares what the SQL worker loads besides its bundle, in web/sql/dist/:
#
#   sqlite3mc/sqlite3.mjs, sqlite3mc/sqlite3.wasm
#       SQLite3 Multiple Ciphers' WebAssembly build (SQLite + FTS5 + the
#       encrypting VFS), the release below, checked against its SHA-256
#   signal_tokenizer.wasm
#       Signal's FTS5 tokenizer (sql/tokenizer/, Rust)
#
# renderer/build.sh runs this; renderer/build.mjs bundles the worker.
# Needs curl, unzip, and the Rust toolchain in sql/tokenizer/rust-toolchain.toml
# with the wasm32-wasip1 target.
set -euo pipefail

SQLITE3MC_VERSION=2.5.1
SQLITE_VERSION=3.53.4
SQLITE3MC_SHA256=761a41b8dc996cfa21f193fc044739fbb0c4a31a1fd657a4df49cc59085577ce

SQL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$SQL/dist"
mkdir -p "$DIST/sqlite3mc"

name="sqlite3mc-${SQLITE3MC_VERSION}-sqlite-${SQLITE_VERSION}-wasm"
stamp="$DIST/sqlite3mc/VERSION"
if [ "$(cat "$stamp" 2>/dev/null)" != "$name" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -sSfL -o "$tmp/$name.zip" \
    "https://github.com/utelle/SQLite3MultipleCiphers/releases/download/v${SQLITE3MC_VERSION}/$name.zip"
  echo "$SQLITE3MC_SHA256  $tmp/$name.zip" | sha256sum -c --quiet -
  unzip -q "$tmp/$name.zip" -d "$tmp/x"
  jswasm="$(find "$tmp/x" -type d -name jswasm | head -n1)"
  cp "$jswasm/sqlite3.mjs" "$jswasm/sqlite3.wasm" "$DIST/sqlite3mc/"
  echo "$name" > "$stamp"
fi

(
  cd "$SQL/tokenizer"
  target_dir="${TOKENIZER_TARGET_DIR:-$SQL/tokenizer/target}"
  CARGO_TARGET_DIR="$target_dir" cargo build --locked --release --target wasm32-wasip1 --quiet
  cp "$target_dir/wasm32-wasip1/release/receiver_signal_tokenizer.wasm" "$DIST/signal_tokenizer.wasm"
)

echo "sql: $name, signal_tokenizer.wasm $(stat -c %s "$DIST/signal_tokenizer.wasm") bytes"
