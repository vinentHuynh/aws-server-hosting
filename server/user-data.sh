#!/usr/bin/env bash
# Rendered by lib/server-stack.ts (tokens like __MOUNT_POINT__ are substituted
# at synth time) and run as EC2 user-data on every boot. Must be idempotent
# and must never reformat or erase an already-initialized world volume.
set -euo pipefail

LOG_FILE=/var/log/mc-ondemand-bootstrap.log
exec > >(tee -a "$LOG_FILE") 2>&1
echo "=== mc-ondemand bootstrap: $(date -u) ==="

MOUNT_POINT="__MOUNT_POINT__"
SERVICE_USER="__SERVICE_USER__"
WORLD_VOLUME_ID="__WORLD_VOLUME_ID__"
MC_PORT="__MC_PORT__"
RCON_PORT="__RCON_PORT__"
MAX_PLAYERS="__MAX_PLAYERS__"
RCON_PARAM_NAME="__RCON_PARAM_NAME__"
EULA_ACCEPTED="__EULA_ACCEPTED__"
IDLE_TIMEOUT_SECONDS="__IDLE_TIMEOUT_SECONDS__"
IDLE_CHECK_INTERVAL_MINUTES="__IDLE_CHECK_INTERVAL_MINUTES__"
PAPER_MC_VERSION="__PAPER_MC_VERSION__"
DISCORD_WEBHOOK_PARAM_NAME="__DISCORD_WEBHOOK_PARAM_NAME__"
CONNECT_HOSTNAME="__CONNECT_HOSTNAME__"
JVM_XMS="1G"
JVM_XMX="3G"

# --- Detect and mount the world volume -------------------------------------

VOLUME_ID_NO_DASH="$(echo "$WORLD_VOLUME_ID" | tr -d '-')"
BY_ID_PATH="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${VOLUME_ID_NO_DASH}"

DEVICE=""
for _ in $(seq 1 30); do
  if [[ -e "$BY_ID_PATH" ]]; then
    DEVICE="$(readlink -f "$BY_ID_PATH")"
    break
  fi
  sleep 2
done

if [[ -z "$DEVICE" ]]; then
  echo "FATAL: could not find world volume $WORLD_VOLUME_ID at $BY_ID_PATH" >&2
  exit 1
fi
echo "World volume $WORLD_VOLUME_ID resolved to $DEVICE"

if ! blkid "$DEVICE" >/dev/null 2>&1; then
  echo "No filesystem detected on $DEVICE, formatting as ext4 (first boot only)"
  mkfs.ext4 -L mcworld "$DEVICE"
else
  echo "Filesystem already present on $DEVICE, leaving world data untouched"
fi

mkdir -p "$MOUNT_POINT"
VOLUME_UUID="$(blkid -s UUID -o value "$DEVICE")"
if ! grep -q "$VOLUME_UUID" /etc/fstab; then
  echo "UUID=${VOLUME_UUID} ${MOUNT_POINT} ext4 defaults,nofail 0 2" >> /etc/fstab
fi

if ! mountpoint -q "$MOUNT_POINT"; then
  mount "$MOUNT_POINT"
fi

if ! mountpoint -q "$MOUNT_POINT"; then
  echo "FATAL: $MOUNT_POINT did not mount; refusing to write world data to the root volume" >&2
  exit 1
fi
echo "World volume mounted at $MOUNT_POINT"

# --- System packages ---------------------------------------------------------

if ! command -v aws >/dev/null 2>&1; then
  dnf install -y awscli
fi

dnf install -y java-21-amazon-corretto-headless jq tar
java -version

if ! command -v mcrcon >/dev/null 2>&1; then
  echo "Building mcrcon from source"
  dnf groupinstall -y "Development Tools" || dnf install -y gcc make git
  TMP_DIR="$(mktemp -d)"
  git clone --depth 1 https://github.com/Tiiffi/mcrcon.git "$TMP_DIR/mcrcon"
  (cd "$TMP_DIR/mcrcon" && make && install -m 0755 mcrcon /usr/local/bin/mcrcon)
  rm -rf "$TMP_DIR"
fi
mcrcon -h >/dev/null 2>&1 || { echo "FATAL: mcrcon install failed" >&2; exit 1; }

# --- Service user -------------------------------------------------------------

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$MOUNT_POINT" --shell /sbin/nologin "$SERVICE_USER"
fi
chown -R "${SERVICE_USER}:${SERVICE_USER}" "$MOUNT_POINT"

# --- Server files --------------------------------------------------------------

SERVER_JAR="$MOUNT_POINT/server.jar"
if [[ ! -f "$SERVER_JAR" ]]; then
  echo "No server jar present, downloading Paper $PAPER_MC_VERSION"
  BUILD="$(curl -s "https://api.papermc.io/v2/projects/paper/versions/${PAPER_MC_VERSION}" | jq -r '.builds[-1]')"
  DOWNLOAD_NAME="paper-${PAPER_MC_VERSION}-${BUILD}.jar"
  curl -s -o "$SERVER_JAR" \
    "https://api.papermc.io/v2/projects/paper/versions/${PAPER_MC_VERSION}/builds/${BUILD}/downloads/${DOWNLOAD_NAME}"
  chown "${SERVICE_USER}:${SERVICE_USER}" "$SERVER_JAR"
else
  echo "Existing server.jar found, leaving it in place"
fi

EULA_FILE="$MOUNT_POINT/eula.txt"
if [[ "$EULA_ACCEPTED" == "true" ]]; then
  echo "eula=true" > "$EULA_FILE"
else
  echo "eula=false" > "$EULA_FILE"
  echo "WARNING: mcEulaAccepted=false in CDK context; server will refuse to start until the operator accepts https://www.minecraft.net/en-us/eula and redeploys with mcEulaAccepted=true" >&2
fi
chown "${SERVICE_USER}:${SERVICE_USER}" "$EULA_FILE"

RCON_PASSWORD="$(aws ssm get-parameter --name "$RCON_PARAM_NAME" --with-decryption --query 'Parameter.Value' --output text --region "$(curl -s -H "X-aws-ec2-metadata-token: $(curl -s -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/placement/region)" 2>/dev/null || true)"

if [[ -z "$RCON_PASSWORD" ]]; then
  echo "FATAL: could not read RCON password from SSM parameter $RCON_PARAM_NAME. Create it with:" >&2
  echo "  aws ssm put-parameter --name $RCON_PARAM_NAME --type SecureString --value '<password>'" >&2
  exit 1
fi

PROPERTIES_FILE="$MOUNT_POINT/server.properties"
touch "$PROPERTIES_FILE"
set_property() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$PROPERTIES_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$PROPERTIES_FILE"
  else
    echo "${key}=${value}" >> "$PROPERTIES_FILE"
  fi
}
set_property server-port "$MC_PORT"
set_property enable-rcon true
set_property rcon.port "$RCON_PORT"
set_property "rcon.password" "$RCON_PASSWORD"
set_property max-players "$MAX_PLAYERS"
# RCON must stay bound to localhost; no inbound security-group rule exists for it.
set_property broadcast-rcon-to-ops false
chown "${SERVICE_USER}:${SERVICE_USER}" "$PROPERTIES_FILE"
chmod 600 "$PROPERTIES_FILE"

# --- systemd service -----------------------------------------------------------

cat > /etc/systemd/system/mcserver.service <<EOF
[Unit]
Description=Minecraft server
After=network-online.target ${MOUNT_POINT#/}.mount
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${MOUNT_POINT}
ExecStart=/usr/bin/java -Xms${JVM_XMS} -Xmx${JVM_XMX} -jar ${SERVER_JAR} nogui
Restart=on-failure
RestartSec=15
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable mcserver.service
systemctl restart mcserver.service

# --- Idle checker, manual-stop, and ready-notify installation -------------------

cat > /etc/mc-ondemand.env <<EOF
SERVICE_NAME=mcserver
RCON_PORT=${RCON_PORT}
RCON_PARAM_NAME=${RCON_PARAM_NAME}
IDLE_TIMEOUT_SECONDS=${IDLE_TIMEOUT_SECONDS}
STATE_DIR=/var/run/mc-ondemand
DISCORD_WEBHOOK_PARAM_NAME=${DISCORD_WEBHOOK_PARAM_NAME}
CONNECT_HOSTNAME=${CONNECT_HOSTNAME}
EOF
chmod 600 /etc/mc-ondemand.env

install -m 0755 -o root -g root /tmp/idle-check.sh /usr/local/bin/mc-idle-check.sh
install -m 0755 -o root -g root /tmp/manual-stop.sh /usr/local/bin/mc-manual-stop.sh
install -m 0755 -o root -g root /tmp/ready-notify.sh /usr/local/bin/mc-ready-notify.sh

cat > /etc/systemd/system/mc-idle-check.service <<EOF
[Unit]
Description=Stop the instance after the Minecraft server is idle

[Service]
Type=oneshot
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
ExecStart=/usr/local/bin/mc-idle-check.sh
EOF

cat > /etc/systemd/system/mc-idle-check.timer <<EOF
[Unit]
Description=Run mc-idle-check periodically

[Timer]
OnBootSec=${IDLE_CHECK_INTERVAL_MINUTES}min
OnUnitActiveSec=${IDLE_CHECK_INTERVAL_MINUTES}min
AccuracySec=30s

[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/mc-ready-notify.service <<EOF
[Unit]
Description=Announce Minecraft server readiness on Discord
After=mcserver.service

[Service]
Type=oneshot
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
ExecStart=/usr/local/bin/mc-ready-notify.sh
EOF

systemctl daemon-reload
systemctl enable --now mc-idle-check.timer
systemctl enable --now mc-ready-notify.service

echo "=== mc-ondemand bootstrap complete: $(date -u) ==="
