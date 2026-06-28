#!/usr/bin/env bash
# Oneshot, runs once per boot (After=mcserver.service) and announces readiness
# on Discord once the server finishes starting. Webhook is optional and
# missing config is not an error — it just skips the notification.
set -euo pipefail

ENV_FILE=/etc/mc-ondemand.env
if [[ ! -f "$ENV_FILE" ]]; then
  echo "mc-ready-notify: missing $ENV_FILE, aborting" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

SERVICE_NAME="${SERVICE_NAME:-mcserver}"
WEBHOOK_PARAM_NAME="${DISCORD_WEBHOOK_PARAM_NAME:-}"
CONNECT_HOSTNAME="${CONNECT_HOSTNAME:-}"

log() {
  echo "mc-ready-notify: $*"
}

READY=""
for _ in $(seq 1 120); do
  if journalctl -u "$SERVICE_NAME" -b --no-pager 2>/dev/null | grep -q "Done ("; then
    READY="1"
    break
  fi
  sleep 5
done

if [[ -z "$READY" ]]; then
  log "server did not report ready within 10 minutes, skipping notification"
  exit 0
fi
log "server reported ready"

if [[ -z "$WEBHOOK_PARAM_NAME" ]]; then
  log "no webhook configured, skipping notification"
  exit 0
fi

IMDS_TOKEN="$(curl -s -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)"
REGION="$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region)"
WEBHOOK_URL="$(aws ssm get-parameter --name "$WEBHOOK_PARAM_NAME" --with-decryption --query 'Parameter.Value' --output text --region "$REGION" 2>/dev/null || true)"

if [[ -z "$WEBHOOK_URL" ]]; then
  log "webhook parameter $WEBHOOK_PARAM_NAME not set, skipping notification"
  exit 0
fi

CONNECT_TEXT=""
[[ -n "$CONNECT_HOSTNAME" ]] && CONNECT_TEXT=" Connect at ${CONNECT_HOSTNAME}:25565"
PAYLOAD="$(printf '{"content":"🟢 Server is online!%s"}' "$CONNECT_TEXT")"
curl -s -X POST -H 'Content-Type: application/json' -d "$PAYLOAD" "$WEBHOOK_URL" >/dev/null \
  || log "webhook POST failed"
