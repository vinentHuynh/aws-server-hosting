#!/usr/bin/env bash
# Registers /start, /stop, /status as guild-scoped commands (instant
# propagation, vs ~1hr for global) for development. Re-run whenever the
# command list changes. Requires DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN,
# and DISCORD_GUILD_ID in the environment -- never hardcode these.
set -euo pipefail

: "${DISCORD_APPLICATION_ID:?set DISCORD_APPLICATION_ID}"
: "${DISCORD_BOT_TOKEN:?set DISCORD_BOT_TOKEN}"
: "${DISCORD_GUILD_ID:?set DISCORD_GUILD_ID}"

COMMANDS='[
  {"name":"start","description":"Start the Minecraft server","type":1},
  {"name":"stop","description":"Stop the Minecraft server gracefully","type":1},
  {"name":"status","description":"Check Minecraft server status","type":1},
  {"name":"cost","description":"Show this month'"'"'s AWS spend and projected total","type":1}
]'

curl -sS -X PUT \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$COMMANDS" \
  "https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands"
echo
