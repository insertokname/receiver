// SPDX-License-Identifier: AGPL-3.0-only
//
// The Signal Desktop release to merge next: of the tags on stdin (one per
// line), the newest stable release (vX.Y.Z, no beta or alpha) newer than
// `current` (package.json's version, which may be a prerelease: the base
// 8.33.0-alpha.1 comes before the release 8.33.0). Prints nothing when there
// is none. Used by .github/workflows/web-upstream.yml.
//
//   git tag -l 'v*' | node web/scripts/upstream-release.mjs 8.33.0-alpha.1

import { readFileSync } from 'node:fs';

/** [major, minor, patch, prerelease?] or undefined. */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]];
}

/** Negative, zero or positive, as `a` comes before, with or after `b`. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  // A prerelease comes before its release; prereleases are not compared
  // with each other here (only stable releases are candidates).
  if (a[3] === b[3]) return 0;
  if (a[3] === undefined) return 1;
  if (b[3] === undefined) return -1;
  return 0;
}

export function nextRelease(tags, current) {
  const base = parseVersion(current);
  if (!base) throw new Error(`not a version: ${current}`);
  let best;
  for (const tag of tags) {
    const version = parseVersion(tag);
    if (!version || version[3] !== undefined || !tag.startsWith('v')) continue;
    if (compareVersions(version, base) <= 0) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { tag: tag.trim(), version };
  }
  return best?.tag;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const current = process.argv[2];
  const tags = readFileSync(0, 'utf8').split('\n').filter(Boolean);
  const tag = nextRelease(tags, current);
  if (tag) console.log(tag);
}
