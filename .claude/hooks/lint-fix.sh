#!/usr/bin/env bash
# PostToolUse hook: auto-fix eslint + prettier on the file Claude just edited.
set -u
file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -n "$file" ] && [ -f "$file" ] || exit 0
cd "$(dirname "$0")/../.." || exit 0
case "$file" in
  *.ts|*.tsx|*.js|*.mjs|*.cjs) npx eslint --fix "$file" >/dev/null 2>&1 ;;
esac
npx prettier --write --ignore-unknown "$file" >/dev/null 2>&1
exit 0
