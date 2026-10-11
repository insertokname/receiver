#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Rebuilds the site from source and compares it with a deployed copy:
#
#   1. reads URL/SOURCE (the commit the deployment says it was built from)
#      and URL/SHA256SUMS (the digest of every file but the Tor directory
#      snapshot);
#   2. downloads every listed file from URL and checks it against SHA256SUMS;
#   3. checks out that commit (with its submodules) into WORK_DIR, builds the
#      site exactly as the deployment workflow does, and compares the two
#      SHA256SUMS.
#
# Exit status 0 only if the deployed files are the files this source builds.
#
# Usage: scripts/verify-site.sh [URL] [--commit SHA] [--work-dir DIR] [--repo GIT_URL] [--deployed-only]
#   URL       default https://receiver.insertokname.com/
#   --deployed-only   only step 2: the deployed files match the deployed SHA256SUMS
#   --commit  build this commit instead of the one URL/SOURCE names
#   --work-dir   where to check out and build (default: a new temporary
#             directory; kept afterwards for inspection)
#   --repo    where to get the source (default: this repository)
#
# Needs the toolchains web/README.md lists (the versions pinned there and in
# .github/workflows/web-pages.yml: Rust toolchains from the rust-toolchain
# files, wasm-pack, binaryen, clang for ring's C code, node, pnpm), curl,
# git and network access (dependencies, the Tor directory snapshot of URL).
set -euo pipefail

WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="https://receiver.insertokname.com/"
COMMIT=""
WORK=""
DEPLOYED_ONLY=false
REPO_SRC="$(cd "$WEB/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT="$2"; shift 2 ;;
    --work-dir) WORK="$2"; shift 2 ;;
    --repo) REPO_SRC="$2"; shift 2 ;;
    --deployed-only) DEPLOYED_ONLY=true; shift ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) URL="$1"; shift ;;
  esac
done
URL="${URL%/}/"
WORK="${WORK:-$(mktemp -d)}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
LIVE="$WORK/live"
SRC="$WORK/src"
mkdir -p "$LIVE"

echo "== deployed site: $URL"
curl -sSf -o "$LIVE/SOURCE" "${URL}SOURCE"
curl -sSf -o "$LIVE/SHA256SUMS" "${URL}SHA256SUMS"
cat "$LIVE/SOURCE"
if [ -z "$COMMIT" ]; then
  COMMIT="$(sed -n 's/^receiver \([0-9a-f]\{40\}\)$/\1/p' "$LIVE/SOURCE")"
  [ -n "$COMMIT" ] || { echo "no commit in ${URL}SOURCE" >&2; exit 1; }
fi

echo "== downloading the $(wc -l < "$LIVE/SHA256SUMS") listed files"
mkdir -p "$LIVE/files"
cut -c67- "$LIVE/SHA256SUMS" | while IFS= read -r path; do
  printf '%s\n' "url = \"${URL}${path}\"" "output = \"$LIVE/files/$path\"" "create-dirs"
done > "$LIVE/curl.cfg"
curl -sSf --parallel --parallel-max 8 --config "$LIVE/curl.cfg"
(cd "$LIVE/files" && sha256sum --quiet -c "$LIVE/SHA256SUMS") || {
  echo "the deployed files do not match the deployed SHA256SUMS" >&2
  exit 1
}
echo "deployed files match their SHA256SUMS"
if $DEPLOYED_ONLY; then
  exit 0
fi

echo "== source: $COMMIT"
if [ ! -d "$SRC/.git" ]; then
  git clone --quiet --no-checkout "$REPO_SRC" "$SRC"
fi
git -C "$SRC" fetch --quiet origin "$COMMIT" 2>/dev/null || true
git -C "$SRC" checkout --quiet --detach "$COMMIT"
# Submodules from their own repositories (the URLs in .gitmodules).
git -C "$SRC" submodule sync --quiet
git -C "$SRC" submodule update --quiet --init --depth 1 web/transport/webtor-rs web/libsignal/libsignal

echo "== the Tor directory snapshot (data, not compared) from $URL"
mkdir -p "$WORK/tor"
for name in consensus certs microdescriptors; do
  curl -sSf -o "$WORK/tor/$name.txt.br" "${URL}transport/tor/$name.txt.br"
done

echo "== building (as .github/workflows/web-pages.yml)"
(
  cd "$SRC/web"
  pnpm install --frozen-lockfile
  bash transport/build.sh
  bash libsignal/build.sh
  (cd .. && pnpm install --frozen-lockfile --ignore-scripts)
  bash renderer/build.sh
  bash scripts/build-site.sh --tor-dir "$WORK/tor"
)

echo "== comparing"
if diff -u "$LIVE/SHA256SUMS" "$SRC/web/dist/site/SHA256SUMS" > "$WORK/SHA256SUMS.diff"; then
  echo "IDENTICAL: the $(wc -l < "$LIVE/SHA256SUMS") files at $URL are the files commit $COMMIT builds"
  exit 0
fi
echo "DIFFERENT: files that differ (- deployed, + rebuilt), details in $WORK:"
grep -E '^[-+][0-9a-f]{64}  ' "$WORK/SHA256SUMS.diff" | cut -c1,67- | sort -k1.2 -u
exit 1
