#!/usr/bin/env bash
# Starts or stops the Minecraft EC2 instance. Looks up the instance ID from the
# deployed stack output instead of hardcoding it, so it keeps working across replacements.
set -euo pipefail

ACTION="${1:-}"
PROFILE="${AWS_PROFILE:-mc-deployer}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${SERVER_STACK_NAME:-McOndemandServer-test}"

if [[ "$ACTION" != "start" && "$ACTION" != "stop" ]]; then
  echo "Usage: $0 start|stop" >&2
  exit 1
fi

INSTANCE_ID="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" \
  --output text)"

if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
  echo "Could not find InstanceId output on stack $STACK_NAME" >&2
  exit 1
fi

if [[ "$ACTION" == "start" ]]; then
  aws ec2 start-instances --instance-ids "$INSTANCE_ID" --profile "$PROFILE" --region "$REGION" >/dev/null
  PUBLIC_IP="$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --profile "$PROFILE" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='PublicIp'].OutputValue" \
    --output text)"
  echo "Starting $INSTANCE_ID... (Minecraft takes a few minutes to boot)"
  echo "Connect at: $PUBLIC_IP:25565"
else
  aws ec2 stop-instances --instance-ids "$INSTANCE_ID" --profile "$PROFILE" --region "$REGION" >/dev/null
  echo "Stopping $INSTANCE_ID..."
fi
