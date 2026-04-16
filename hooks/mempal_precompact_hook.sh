#!/usr/bin/env bash
# nardo PreCompact Hook — saves session state before compaction
#
# Called by Claude Code PreCompact hook.
# Reads conversation context from stdin.

set -euo pipefail

PALACE="${NARDO_PALACE_PATH:-${MEMPAL_PALACE_PATH:-$HOME/.nardo/palace}}"
WING="${NARDO_HOOK_WING:-sessions}"
ROOM="precompact-$(date +%Y-%m-%d)"

CONTENT=$(cat)

if [ ${#CONTENT} -lt 50 ]; then
  exit 0
fi

echo "$CONTENT" | bun run "$(dirname "$0")/../src/cli/index.ts" \
  --palace "$PALACE" \
  add-drawer \
  --wing "$WING" \
  --room "$ROOM" \
  --content-stdin \
  --source "claude_code:precompact_hook" \
  --importance "1.5" \
  2>/dev/null || true

exit 0
