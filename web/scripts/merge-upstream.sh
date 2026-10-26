#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Merges a Signal Desktop release into receiver on a branch upstream/<tag>,
# pushes it, opens a pull request and starts the build and tests on it
# (Web (GitHub Pages) on a branch other than main builds and tests without
# deploying). Merge the pull request when they pass; then main deploys.
#
#   bash web/scripts/merge-upstream.sh [vX.Y.Z]   the newest release by default
#   bash web/scripts/merge-upstream.sh --finish   after resolving conflicts
#                                                 and committing the merge
#
# Only release tags are merged, never Signal's main. .github/ is receiver's
# own: Signal's workflows, templates and settings are left out. When
# Desktop's libsignal version changes, the libsignal fork has to follow
# (README, Merging upstream); the pull request says so.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

libsignal_version() {
  node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf8')).dependencies['@signalapp/libsignal-client'])"
}

finish() {
  local branch tag old new
  branch=$(git branch --show-current)
  tag=${branch#upstream/}
  if [ "$branch" = "$tag" ]; then
    echo "not on an upstream/<tag> branch" >&2
    exit 1
  fi
  old=$(git show origin/main:package.json | libsignal_version)
  new=$(libsignal_version < package.json)
  git push -u origin "$branch"
  {
    echo "Signal Desktop [$tag](https://github.com/signalapp/Signal-Desktop/releases/tag/$tag), merged into receiver."
    echo
    if [ "$old" != "$new" ]; then
      echo "**libsignal changes from $old to $new**: rebase the libsignal fork (insertokname/libsignal, branch \`web-wasm\`) onto libsignal v$new and update the submodule \`web/libsignal/libsignal\` on this branch; the build fails until then."
    else
      echo "libsignal stays at $new."
    fi
    echo
    echo "Build and tests: Web (GitHub Pages) on this branch (not deployed)."
  } | gh pr create --base main --head "$branch" --title "Signal Desktop $tag" --body-file -
  gh workflow run web-pages.yml --ref "$branch"
  echo "pull request opened; build and tests started on $branch"
}

if [ "${1:-}" = "--finish" ]; then
  finish
  exit 0
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "commit or set aside your changes first" >&2
  exit 1
fi
git remote get-url upstream > /dev/null 2>&1 || git remote add upstream https://github.com/signalapp/Signal-Desktop.git
git fetch --quiet origin main
git fetch --quiet --no-tags upstream '+refs/tags/v*:refs/tags/v*'
current=$(git show origin/main:package.json | node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf8')).version)")
tag=${1:-$(git tag -l 'v*' | node web/scripts/upstream-release.mjs "$current")}
if [ -z "$tag" ]; then
  echo "receiver is based on $current; no newer Signal Desktop release"
  exit 0
fi
if git merge-base --is-ancestor "$tag" origin/main; then
  echo "$tag is already merged"
  exit 0
fi

git switch -c "upstream/$tag" origin/main
git merge --no-commit --no-ff "$tag" || true
# .github/ stays receiver's: Signal's files there are dropped, whether the
# release changed them (a conflict with their deletion here) or added them.
for path in $(git diff --name-only --diff-filter=U -- .github) $(git diff --cached --name-only --diff-filter=A -- .github); do
  case "$path" in
    .github/workflows/web-*) ;;
    *) git rm -q --force -- "$path" ;;
  esac
done
conflicts=$(git diff --name-only --diff-filter=U)
if [ -n "$conflicts" ]; then
  echo "merging $tag conflicts in:"
  echo "$conflicts" | sed 's/^/  /'
  echo "resolve them, git commit, then: bash web/scripts/merge-upstream.sh --finish"
  exit 1
fi
git commit -q -m "merge signal desktop $tag"
finish
