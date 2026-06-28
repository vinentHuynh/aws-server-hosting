#!/usr/bin/env bash
# Sets the application's Interactions Endpoint URL via the API instead of the
# portal UI. Discord validates the endpoint (sends it a PING) before accepting,
# so the DiscordStack must already be deployed and working. Re-run whenever
# the API Gateway URL changes (e.g. after a stack replacement).
set -euo pipefail

: "${DISCORD_BOT_TOKEN:?set DISCORD_BOT_TOKEN}"
: "${DISCORD_INTERACTIONS_URL:?set DISCORD_INTERACTIONS_URL}"

curl -sS -X PATCH \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"interactions_endpoint_url\": \"${DISCORD_INTERACTIONS_URL}\"}" \
  "https://discord.com/api/v10/applications/@me"
echo
