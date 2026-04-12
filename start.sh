#!/usr/bin/env bash
# Start the Mimir MCP Server with environment loaded from .env
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Try local .env first (standalone repo), then parent .env (nested in gobot)
LOCAL_ENV="$SCRIPT_DIR/.env"
PARENT_ENV="$SCRIPT_DIR/../.env"

if [ -f "$LOCAL_ENV" ]; then
  set -a
  source "$LOCAL_ENV"
  set +a
  echo "[mimir] Loaded env from $LOCAL_ENV (ANTHROPIC_API_KEY=$(test -n "$ANTHROPIC_API_KEY" && echo 'set' || echo 'NOT SET'))" >&2
elif [ -f "$PARENT_ENV" ]; then
  set -a
  source "$PARENT_ENV"
  set +a
  echo "[mimir] Loaded env from $PARENT_ENV (ANTHROPIC_API_KEY=$(test -n "$ANTHROPIC_API_KEY" && echo 'set' || echo 'NOT SET'))" >&2
else
  echo "[mimir] WARNING: No .env found (checked $LOCAL_ENV and $PARENT_ENV)" >&2
fi

exec bun run "$SCRIPT_DIR/src/index.ts"
