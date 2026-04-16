#!/usr/bin/env bash
# nardo Stop Hook — saves session diary to palace
#
# Called by Claude Code Stop hook.
# Input: session transcript via stdin (Claude Code pipes it)
#
# Usage in .claude/settings.json:
# { "hooks": { "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.nardo/hooks/mempal_save_hook.sh" }] }] } }

set -euo pipefail

PALACE="${NARDO_PALACE_PATH:-${MEMPAL_PALACE_PATH:-$HOME/.nardo/palace}}"
WING="${NARDO_HOOK_WING:-sessions}"
ROOM=$(date +%Y-%m-%d)
AGENT="stop_hook"

# Read content from stdin
CONTENT=$(cat)

# Skip if empty or too short
if [ ${#CONTENT} -lt 50 ]; then
  exit 0
fi

# Call nardo CLI to file the drawer
echo "$CONTENT" | bun run "$(dirname "$0")/../src/cli/index.ts" \
  --palace "$PALACE" \
  add-drawer \
  --wing "$WING" \
  --room "$ROOM" \
  --content-stdin \
  --source "claude_code:stop_hook:$AGENT" \
  2>/dev/null || true

exit 0
