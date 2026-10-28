#!/bin/bash
set -Eeuo pipefail

PORT=5000
COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"
DEPLOY_RUN_PORT="${DEPLOY_RUN_PORT:-${PORT}}"

cd "${COZE_WORKSPACE_PATH}"
echo "Starting HTTP service on port ${DEPLOY_RUN_PORT} for dev..."
PORT="${DEPLOY_RUN_PORT}" pnpm exec tsx watch src/server.ts
