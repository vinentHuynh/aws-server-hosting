#!/usr/bin/env bash
# Polled every few minutes by mc-idle-check.timer. Stops the instance after
# the server has had zero players for IDLE_TIMEOUT_SECONDS continuously.
set -euo pipefail

ENV_FILE=/etc/mc-ondemand.env
if [[ ! -f "$ENV_FILE" ]]; then
  echo "mc-idle-check: missing $ENV_FILE, aborting" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

SERVICE_NAME="${SERVICE_NAME:-mcserver}"
RCON_PORT="${RCON_PORT:-25575}"
IDLE_TIMEOUT_SECONDS="${IDLE_TIMEOUT_SECONDS:-1500}"
STATE_DIR="${STATE_DIR:-/var/run/mc-ondemand}"
mkdir -p "$STATE_DIR"

LOCK_FILE="$STATE_DIR/idle-check.lock"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

EMPTY_SINCE_FILE="$STATE_DIR/empty-since"
STOP_REQUESTED_FILE="$STATE_DIR/stop-requested"

log() {
  echo "mc-idle-check: $*"
}

# Best-effort; the webhook is optional, so a missing parameter or failed POST
# must never block the actual shutdown.
post_webhook() {
  local message="$1"
  local param_name="${DISCORD_WEBHOOK_PARAM_NAME:-}"
  [[ -n "$param_name" ]] || return 0
  local region
  region="$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || true)"
  local webhook_url
  webhook_url="$(aws ssm get-parameter --name "$param_name" --with-decryption --query 'Parameter.Value' --output text --region "$region" 2>/dev/null || true)"
  [[ -n "$webhook_url" ]] || return 0
  curl -s -X POST -H 'Content-Type: application/json' \
    -d "$(printf '{"content":"%s"}' "$message")" "$webhook_url" >/dev/null \
    || log "webhook POST failed"
}

if [[ -f "$STOP_REQUESTED_FILE" ]]; then
  log "stop already requested, skipping"
  exit 0
fi

if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  log "$SERVICE_NAME is not active, skipping"
  exit 0
fi

IMDS_TOKEN="$(curl -s -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)"
if [[ -z "$IMDS_TOKEN" ]]; then
  log "could not retrieve IMDSv2 token, skipping"
  exit 0
fi
REGION="$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)"
INSTANCE_ID="$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)"

RCON_PASSWORD="$(aws ssm get-parameter --name "$RCON_PARAM_NAME" --with-decryption --query 'Parameter.Value' --output text --region "$REGION" 2>/dev/null || true)"
if [[ -z "$RCON_PASSWORD" ]]; then
  log "could not retrieve RCON password, treating server as not ready"
  exit 0
fi

LIST_OUTPUT="$(mcrcon -H 127.0.0.1 -P "$RCON_PORT" -p "$RCON_PASSWORD" list 2>/dev/null || true)"
if [[ -z "$LIST_OUTPUT" ]]; then
  log "RCON unavailable, treating server as not ready"
  exit 0
fi

PLAYER_COUNT="$(echo "$LIST_OUTPUT" | grep -oE 'There are [0-9]+' | grep -oE '[0-9]+' || true)"
if [[ -z "$PLAYER_COUNT" ]]; then
  log "could not parse player count from mcrcon output: $LIST_OUTPUT"
  exit 0
fi

if [[ "$PLAYER_COUNT" -gt 0 ]]; then
  log "$PLAYER_COUNT player(s) online, resetting idle timer"
  rm -f "$EMPTY_SINCE_FILE"
  exit 0
fi

NOW="$(date +%s)"

if [[ ! -f "$EMPTY_SINCE_FILE" ]]; then
  log "server is empty, starting idle timer"
  echo "$NOW" > "$EMPTY_SINCE_FILE"
  exit 0
fi

EMPTY_SINCE="$(cat "$EMPTY_SINCE_FILE")"
ELAPSED=$(( NOW - EMPTY_SINCE ))
log "server empty for ${ELAPSED}s (threshold ${IDLE_TIMEOUT_SECONDS}s)"

if [[ "$ELAPSED" -lt "$IDLE_TIMEOUT_SECONDS" ]]; then
  exit 0
fi

log "idle threshold reached, shutting down gracefully"
touch "$STOP_REQUESTED_FILE"
post_webhook "💤 Server was empty for 25 min — shutting down to save costs."

mcrcon -H 127.0.0.1 -P "$RCON_PORT" -p "$RCON_PASSWORD" save-all || true
sleep 5
mcrcon -H 127.0.0.1 -P "$RCON_PORT" -p "$RCON_PASSWORD" stop || true

for _ in $(seq 1 30); do
  systemctl is-active --quiet "$SERVICE_NAME" || break
  sleep 1
done

log "stopping instance $INSTANCE_ID in $REGION"
aws ec2 stop-instances --instance-ids "$INSTANCE_ID" --region "$REGION" || log "stop-instances call failed"
