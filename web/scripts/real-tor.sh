#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Runs a check that goes through the real Tor network, and once more if it
# fails: Snowflake bridges and Tor circuits fail now and then for reasons
# outside this code, and a daily build that fails for one of them leaves the
# site's Tor directory snapshot to expire. A check that fails twice in a row
# fails the build.
#
#   bash web/scripts/real-tor.sh node web/renderer/run.mjs

"$@" && exit 0
echo "::warning::failed over the real Tor network, running it once more: $*"
exec "$@"
