#!/usr/bin/env bash
# Invoked via SSM Run Command by the Stop Lambda for a manual /stop. Unlike
# idle-check.sh, this runs unconditionally regardless of player count.
set -euo pipefail

ENV_FILE=/etc/mc-ondemand.env
if [[ ! -f "$ENV_FILE" ]]; then
  echo "mc-manual-stop: missing $ENV_FILE, aborting" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

SERVICE_NAME="${SERVICE_NAME:-mcserver}"
RCON_PORT="${RCON_PORT:-25575}"

log() {
  echo "mc-manual-stop: $*"
}

if ! systemctl is-active --quiet "$SERVICE_NAME"; then
  log "$SERVICE_NAME is not active, nothing to stop"
  exit 0
fi

IMDS_TOKEN="$(curl -s -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)"
REGION="$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)"
RCON_PASSWORD="$(aws ssm get-parameter --name "$RCON_PARAM_NAME" --with-decryption --query 'Parameter.Value' --output text --region "$REGION" 2>/dev/null || true)"

if [[ -n "$RCON_PASSWORD" ]]; then
  mcrcon -H 127.0.0.1 -P "$RCON_PORT" -p "$RCON_PASSWORD" save-all || true
  sleep 5
  mcrcon -H 127.0.0.1 -P "$RCON_PORT" -p "$RCON_PASSWORD" stop || true
else
  log "could not retrieve RCON password, stopping the service directly without a save"
  systemctl stop "$SERVICE_NAME" || true
fi

for _ in $(seq 1 30); do
  systemctl is-active --quiet "$SERVICE_NAME" || break
  sleep 1
done

log "graceful shutdown complete"
