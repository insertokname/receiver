#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Builds dist/package: @signalapp/libsignal-client (same version as Signal
# Desktop's) with its native addon replaced by libsignal's own Node bridge
# compiled to WebAssembly (wasm32-wasip1, run on emnapi). Networking
# (libsignal-net) is left out; see README.md.
#
# Needs: the toolchain pinned in libsignal/rust-toolchain with the
# wasm32-wasip1 target and the rust-src component, protoc, wasm-opt
# (binaryen), node, and web/'s node_modules (pnpm install). Cargo output goes to $LIBSIGNAL_TARGET_DIR
# (default: ./target).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
src=$here/libsignal
out=$here/dist/package
tsc=$here/../node_modules/.bin/tsc
export CARGO_TARGET_DIR=${LIBSIGNAL_TARGET_DIR:-$here/target}

[[ -f $src/node/package.json ]] || { echo "missing $src; run: git submodule update --init web/libsignal/libsignal" >&2; exit 1; }
[[ -x $tsc ]] || { echo "missing $tsc; run pnpm install in web/" >&2; exit 1; }

echo "== cargo build (wasm32-wasip1)"
(
  cd "$src"
  export CARGO_PROFILE_RELEASE_LTO=fat CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 CARGO_PROFILE_RELEASE_DEBUG=0
  # Rust panics must unwind (as in the native addon, where Neon turns them
  # into JavaScript exceptions) instead of aborting, which would leave the
  # instance in an undefined state. The prebuilt wasm32-wasip1 std only
  # aborts, so std is rebuilt from this toolchain's rust-src with WebAssembly
  # exception handling; -Zbuild-std needs RUSTC_BOOTSTRAP on a stable
  # toolchain. Build-machine paths are kept out of the module.
  export RUSTC_BOOTSTRAP=1
  sysroot=$(rustc --print sysroot)
  export RUSTFLAGS="-C panic=unwind -C target-feature=+exception-handling --remap-path-prefix=$src=libsignal --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=cargo --remap-path-prefix=$sysroot/lib/rustlib/src/rust=rust --remap-path-prefix=$CARGO_TARGET_DIR=target"
  cargo build --locked --release --target wasm32-wasip1 -Zbuild-std=std,panic_unwind \
    -p libsignal-node --features log/release_max_level_info
)

echo "== wasm-opt"
rm -rf "$out"
mkdir -p "$out/wasm"
wasm-opt -O3 --enable-exception-handling "$CARGO_TARGET_DIR/wasm32-wasip1/release/signal_node.wasm" -o "$out/wasm/libsignal_node.wasm"

echo "== TypeScript"
"$tsc" -p "$here/tsconfig.json"

# The package loads its addon with node-gyp-build; point that at the loader.
native=$out/dist/Native.js
[[ $(grep -c "^import load from 'node-gyp-build';$" "$native") == 1 ]] ||
  { echo "unexpected node-gyp-build import in $native" >&2; exit 1; }
sed -i "s|^import load from 'node-gyp-build';$|import load from '../wasm/index.js';|" "$native"

integrity="sha384-$(openssl dgst -sha384 -binary "$out/wasm/libsignal_node.wasm" | base64 -w0)"
sed "s|@WASM_INTEGRITY@|$integrity|" "$here/loader.js" > "$out/wasm/index.js"
cp "$here/loader.d.ts" "$out/wasm/index.d.ts"
cp "$src/node/zkgroup.js" "$src/node/zkgroup.d.ts" "$out/"
node -e '
  const [from, to] = process.argv.slice(1);
  const p = require(from);
  const pkg = { name: p.name, version: p.version, license: p.license, type: p.type, main: p.main, types: p.types };
  require("fs").writeFileSync(to, JSON.stringify(pkg, null, 2) + "\n");
' "$src/node/package.json" "$out/package.json"
# libsignal's tests read their fixtures from ../../ts/test relative to dist/test.
ln -s ../../libsignal/node/ts "$out/ts"

size=$(stat -c %s "$out/wasm/libsignal_node.wasm")
gz=$(gzip -9 -c "$out/wasm/libsignal_node.wasm" | wc -c)
echo "== done: $out (libsignal_node.wasm $size bytes, $gz gzipped)"
