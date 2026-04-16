#!/usr/bin/env bash
# Install nardo hooks to ~/.nardo/hooks/

set -euo pipefail

HOOKS_DIR="$HOME/.nardo/hooks"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$HOOKS_DIR"
cp "$SCRIPT_DIR/mempal_save_hook.sh" "$HOOKS_DIR/"
cp "$SCRIPT_DIR/mempal_precompact_hook.sh" "$HOOKS_DIR/"
chmod +x "$HOOKS_DIR/mempal_save_hook.sh"
chmod +x "$HOOKS_DIR/mempal_precompact_hook.sh"

echo "Hooks installed to $HOOKS_DIR"
echo ""
echo "Add to your Claude Code settings (~/.claude/settings.json):"
echo '{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "'"$HOOKS_DIR"'/mempal_save_hook.sh" }]
    }],
    "PreCompact": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "'"$HOOKS_DIR"'/mempal_precompact_hook.sh" }]
    }]
  }
}'
