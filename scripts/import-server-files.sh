#!/usr/bin/env bash
# Uploads a local archive (zip/tar.gz/tar) to the staging S3 bucket, then has
# the instance download and extract it into a staging directory under
# /srv/mc-import/ -- NOT directly into the live server directory. Moving
# specific files into /srv/mc is a deliberate manual step after reviewing
# what was extracted, since what belongs there depends on what you're importing.
set -euo pipefail

LOCAL_FILE="${1:-}"
if [[ -z "$LOCAL_FILE" || ! -f "$LOCAL_FILE" ]]; then
  echo "Usage: $0 <path-to-local-archive>" >&2
  exit 1
fi

PROFILE="${AWS_PROFILE:-mc-deployer}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${SERVER_STACK_NAME:-McOndemandServer-test}"
BASENAME="$(basename "$LOCAL_FILE")"
KEY="imports/${BASENAME}"

INSTANCE_ID="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)"
BUCKET="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ImportBucketName'].OutputValue" --output text)"

if [[ -z "$INSTANCE_ID" || -z "$BUCKET" ]]; then
  echo "Could not resolve InstanceId/ImportBucketName outputs on stack $STACK_NAME" >&2
  exit 1
fi

echo "Uploading $LOCAL_FILE to s3://${BUCKET}/${KEY} ..."
aws s3 cp "$LOCAL_FILE" "s3://${BUCKET}/${KEY}" --profile "$PROFILE" --region "$REGION"

STAGING_DIR="/srv/mc-import/${BASENAME%.*}"
# Note: deliberately uses if/elif glob matching instead of a `case` statement.
# A `case ... *.ext)` pattern's literal closing paren, inside this *unquoted*
# heredoc (needed for variable interpolation), confuses bash's parser about
# whether it closes the case arm or the enclosing $(...) substitution --
# silently truncating this variable and running the rest as local commands.
REMOTE_SCRIPT=$(cat <<EOF
set -euo pipefail
mkdir -p "${STAGING_DIR}"
aws s3 cp "s3://${BUCKET}/${KEY}" "/tmp/${BASENAME}" --region "${REGION}"
if [[ "${BASENAME}" == *.zip ]]; then
  command -v unzip >/dev/null 2>&1 || dnf install -y unzip
  unzip -o "/tmp/${BASENAME}" -d "${STAGING_DIR}"
elif [[ "${BASENAME}" == *.tar.gz || "${BASENAME}" == *.tgz ]]; then
  tar xzf "/tmp/${BASENAME}" -C "${STAGING_DIR}"
elif [[ "${BASENAME}" == *.tar ]]; then
  tar xf "/tmp/${BASENAME}" -C "${STAGING_DIR}"
else
  cp "/tmp/${BASENAME}" "${STAGING_DIR}/"
fi
rm -f "/tmp/${BASENAME}"
chown -R mcserver:mcserver "${STAGING_DIR}"
echo "--- extracted to ${STAGING_DIR} ---"
find "${STAGING_DIR}" -maxdepth 2
EOF
)

echo "Downloading and extracting on the instance ..."
PARAMS_JSON="$(REMOTE_SCRIPT="$REMOTE_SCRIPT" python3 -c '
import json, os
print(json.dumps({"commands": [os.environ["REMOTE_SCRIPT"]]}))
')"
CMD_ID="$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --timeout-seconds 300 \
  --parameters "$PARAMS_JSON" \
  --profile "$PROFILE" --region "$REGION" \
  --query 'Command.CommandId' --output text)"

aws ssm wait command-executed --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --profile "$PROFILE" --region "$REGION" || true
aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --profile "$PROFILE" --region "$REGION" \
  --query '{Status:Status,StdOut:StandardOutputContent,StdErr:StandardErrorContent}' --output json
echo "Staged at ${STAGING_DIR} on the instance -- review with SSM, then move specific files into /srv/mc manually."
