#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Builds the Tor transport into web/transport/dist/ (git-ignored):
#   pkg/          webtor-rs compiled to WASM (wasm-pack --target web --release)
#   signal-ca.js  Signal's CA, taken from config/default.json certificateAuthority
#   index.js      the connection policy (src/index.js, types in src/index.d.ts)
#
# Needs: the Rust toolchain pinned in webtor-rs/rust-toolchain.toml with the
# wasm32-unknown-unknown target, wasm-pack, clang + llvm-ar that can target
# wasm32 (for ring; override with CC_wasm32_unknown_unknown /
# AR_wasm32_unknown_unknown), node.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/dist"

if [ ! -f "$HERE/webtor-rs/Cargo.toml" ]; then
  echo "webtor-rs submodule missing: git submodule update --init web/transport/webtor-rs" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"

(cd "$HERE/webtor-rs/webtor-wasm" && wasm-pack build --target web --release --no-pack --out-dir "$OUT/pkg")
rm -f "$OUT/pkg/.gitignore"

# shellcheck disable=SC2016 # JavaScript, not shell
node -e '
  const fs = require("node:fs");
  const pem = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).certificateAuthority;
  const certs = (pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
  if (certs !== 1 || !pem.trim().endsWith("-----END CERTIFICATE-----")) {
    throw new Error(`expected exactly one PEM certificate in certificateAuthority, found ${certs}`);
  }
  fs.writeFileSync(process.argv[2],
    "// Generated from config/default.json certificateAuthority by web/transport/build.sh.\n" +
    "export default " + JSON.stringify(pem) + ";\n");
' "$REPO/config/default.json" "$OUT/signal-ca.js"

cp "$HERE/src/index.js" "$HERE/src/index.d.ts" "$OUT/"

ls -l "$OUT" "$OUT/pkg"
