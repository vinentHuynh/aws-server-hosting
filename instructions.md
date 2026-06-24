# GTNH On-Demand AWS Server

Planning-only checklist for implementation by a coding agent. This document is intentionally a TODO list and does not imply that any infrastructure has been deployed yet.

## 1. Lock implementation decisions

- [ ] Use AWS CDK v2 with TypeScript.
- [ ] Use m6i.large:
	- [ ] 2 vCPU
	- [ ] 8 GB RAM
	- [ ] x86_64
	- [ ] On-Demand by default
	- [ ] Do not use ARM/Graviton.
	- [ ] Do not use a 4 GB instance.
- [ ] Set useSpot=false by default and expose it as CDK context.
- [ ] Use a 30 GB gp3 dedicated world volume.
- [ ] Use a 16 GB gp3 root volume.
- [ ] Configure the Minecraft server for 3 maximum players.
- [ ] Keep the JVM heap at exactly 6 GB.
- [ ] Keep the idle timeout at exactly 25 minutes.
- [ ] Use a public subnet with:
	- [ ] No NAT gateway
	- [ ] No Elastic IP
	- [ ] Dynamic Route 53 DNS update on boot
- [ ] Use the dedicated EBS volume as the authoritative copy of the world.
- [ ] Treat S3 staging as optional rather than required for every boot.
- [ ] Use standard SSM parameters where possible to minimize recurring secret-storage cost.
- [ ] Use Secrets Manager only where its additional protections are specifically needed.

## 2. Scaffold the repository

- [ ] Create:

```text
gtnh-ondemand/
├── bin/
│   └── app.ts
├── lib/
│   ├── network-stack.ts
│   ├── server-stack.ts
│   ├── control-stack.ts
│   └── discord-stack.ts
├── server/
│   ├── user-data.sh
│   └── idle-check.sh
├── lambda/
│   ├── wake/
│   │   └── index.ts
│   ├── stop/
│   │   └── index.ts
│   └── discord/
│       └── index.ts
├── package.json
├── package-lock.json
├── cdk.json
├── tsconfig.json
├── README.md
└── .gitignore
```

- [ ] Run cdk init app --language typescript.
- [ ] Enable strict TypeScript settings.
- [ ] Add scripts for:
	- [ ] build
	- [ ] watch
	- [ ] test
	- [ ] synth
	- [ ] deploy
	- [ ] destroy
- [ ] Install required dependencies:
	- [ ] aws-cdk-lib
	- [ ] constructs
	- [ ] AWS SDK v3 packages
	- [ ] tweetnacl
	- [ ] Appropriate Lambda bundling dependencies
- [ ] Add Lambda bundling with NodejsFunction or equivalent.
- [ ] Ensure npm run build succeeds.
- [ ] Ensure cdk synth succeeds before adding live resources.

## 3. Define configuration and CDK context

- [ ] Add configuration for:
	- [ ] AWS region
	- [ ] useSpot (default false)
	- [ ] SSH source CIDR
	- [ ] Route 53 zone name
	- [ ] Existing hosted zone ID (when supplied)
	- [ ] Minecraft hostname
	- [ ] World volume size (default 30)
	- [ ] Root volume size (default 16)
	- [ ] Instance type (default m6i.large)
	- [ ] Minecraft port (default 25565)
	- [ ] RCON port (default 25575)
	- [ ] Maximum players (default 3)
	- [ ] Idle timeout (default 1500 seconds)
	- [ ] Idle-check interval (default 5 minutes)
	- [ ] Optional S3 server-files bucket
	- [ ] Optional S3 object prefix
	- [ ] Environment name or deployment stage
- [ ] Validate context values during synthesis.

## 4. Implement NetworkStack

### VPC

- [ ] Create a VPC with one public subnet.
- [ ] Set NAT gateways to zero.
- [ ] Ensure the subnet assigns public IPv4 addresses.
- [ ] Alternatively support importing an existing/default VPC.
- [ ] Avoid unnecessary private subnets and NAT charges.

### Security group

- [ ] Allow TCP 25565 from 0.0.0.0/0.
- [ ] Allow TCP 22 only from the configured SSH CIDR.
- [ ] Do not expose TCP 25575.
- [ ] Keep RCON reachable only from localhost.
- [ ] Allow outbound traffic needed for:
	- [ ] Package installation
	- [ ] AWS APIs
	- [ ] Discord webhook calls
	- [ ] Optional S3 downloads

### Route 53

- [ ] Import an existing public hosted zone when an ID is supplied.
- [ ] Otherwise create a public hosted zone.
- [ ] Create or prepare management of an A record for the server hostname.
- [ ] Do not allocate an Elastic IP.
- [ ] Grant the EC2 role permission to update only the required hosted zone or record.
- [ ] Export or expose:
	- [ ] VPC
	- [ ] Public subnet
	- [ ] Security group
	- [ ] Hosted zone ID
	- [ ] Record name

## 5. Implement ServerStack

### EC2 instance

- [ ] Create an m6i.large Linux EC2 instance.
- [ ] Use an x86_64 AMI.
- [ ] Enable IMDSv2 and require metadata tokens.
- [ ] Configure a 16 GB gp3 root volume.
- [ ] Set shutdown behavior appropriately.
- [ ] Add tags:
	- [ ] Role=gtnh-server
	- [ ] Environment/project tags
- [ ] Expose the instance ID to the control stacks.
- [ ] Prevent accidental replacement where practical.
- [ ] Add deletion protection or clear safeguards for stateful resources where appropriate.

### Spot support

- [ ] Support useSpot=true through a launch template.
- [ ] Configure Spot interruption behavior to stop.
- [ ] Keep On-Demand as the default.
- [ ] Document that Spot should only be enabled after reliable backups and interruption handling are verified.

### Dedicated EBS world volume

- [ ] Create a standalone 30 GB gp3 EBS volume.
- [ ] Do not define it as an ephemeral instance root block device.
- [ ] Place it in the same availability zone as the EC2 instance.
- [ ] Attach it to the instance.
- [ ] Enable encryption.
- [ ] Apply a retention policy so stack deletion does not silently destroy the world.
- [ ] Tag it clearly:
	- [ ] Role=gtnh-world
	- [ ] Backup=true
- [ ] Document device-name differences between the EC2 API and Linux NVMe devices.

### IAM instance role

- [ ] Grant only the permissions required for:
	- [ ] Updating the specific Route 53 hosted zone
	- [ ] Reading required SSM parameters
	- [ ] Reading required Secrets Manager secrets (when used)
	- [ ] Reading optional S3 server files
	- [ ] Stopping its own instance
	- [ ] Starting its own instance only when genuinely needed
	- [ ] Calling ec2:DescribeInstances where required
	- [ ] Sending logs or metrics if CloudWatch integration is enabled
- [ ] Scope instance actions using:
	- [ ] Instance ARN where possible
	- [ ] Resource tags where ARN scoping is unavailable
	- [ ] Conditions preventing management of unrelated EC2 instances

### DLM snapshots

- [ ] Create the IAM role required by Data Lifecycle Manager.
- [ ] Create a DLM policy targeting the world-volume backup tag.
- [ ] Run one snapshot daily.
- [ ] Retain approximately seven daily snapshots.
- [ ] Tag snapshots with project and environment metadata.
- [ ] Confirm the 30 GB volume is included.
- [ ] Confirm the root volume is not unintentionally included unless desired.

## 6. Implement server/user-data.sh

The script must be safe to execute repeatedly.

### Shell safety

- [ ] Start with strict shell options:

```bash
set -euo pipefail
```

- [ ] Log bootstrap output to a persistent log.
- [ ] Make operations idempotent.
- [ ] Never erase an initialized world volume.

### Detect and mount the world volume

- [ ] Identify the attached EBS device reliably on Nitro/NVMe instances.
- [ ] Check whether the device already contains a filesystem.
- [ ] Format only when no filesystem exists.
- [ ] Use a suitable filesystem such as ext4 or XFS.
- [ ] Mount at a stable location (for example /srv/gtnh).
- [ ] Add an /etc/fstab entry using the filesystem UUID.
- [ ] Use mount options suitable for a server workload.
- [ ] Verify the mount before placing files.
- [ ] Abort rather than writing world data to the root volume when mounting fails.

### Install system packages

- [ ] Install AWS CLI.
- [ ] Install required archive/download utilities.
- [ ] Install cron or use a systemd timer.
- [ ] Install build dependencies required for mcrcon.
- [ ] Install mcrcon.
- [ ] Install a modern JDK supported by the deployed GTNH version.
- [ ] Do not install Java 8.
- [ ] Target Java 21 when compatible with the installed pack.
- [ ] Verify java -version.
- [ ] Document the pack-version-to-Java-version check in the README.

### Place server files

- [ ] Support server files already present on the EBS volume.
- [ ] Optionally stage initial files from S3 only when the server directory is uninitialized.
- [ ] Never overwrite an existing world during routine boot.
- [ ] Verify these files exist:
	- [ ] lwjgl3ify-forgePatches.jar
	- [ ] java9args.txt
- [ ] Verify the world directory exists.
- [ ] Ensure ownership belongs to a dedicated non-root service user.
- [ ] Create a server user such as gtnh.
- [ ] Avoid running Minecraft as root.

### Configure server.properties

- [ ] Set or preserve:

```properties
server-port=25565
enable-rcon=true
rcon.port=25575
max-players=3
```

- [ ] Read the RCON password from SSM or Secrets Manager.
- [ ] Write rcon.password without exposing it in logs.
- [ ] Bind RCON to localhost where supported.
- [ ] Do not create an inbound security-group rule for RCON.
- [ ] Preserve pack-specific settings not managed by the bootstrap script.
- [ ] Set the EULA only after the operator has explicitly accepted it.

### Create the systemd service

- [ ] Set WorkingDirectory to the server directory.
- [ ] Run under the dedicated service user.
- [ ] Use the exact required command:

```bash
java -Xms6G -Xmx6G -Dfml.readTimeout=180 @java9args.txt -jar lwjgl3ify-forgePatches.jar nogui
```

- [ ] Do not add GC flags.
- [ ] Do not alter -Xms6G.
- [ ] Do not alter -Xmx6G.
- [ ] Set Restart=on-failure.
- [ ] Add sensible restart delays and start-limit protections.
- [ ] Increase systemd startup timeout to tolerate a 3-5 minute boot.
- [ ] Redirect or preserve logs appropriately.
- [ ] Enable the service.
- [ ] Start it after the EBS volume is mounted and networking is available.

### Route 53 update

- [ ] Retrieve an IMDSv2 token.
- [ ] Retrieve the instance public IPv4 address using the token.
- [ ] Update the Route 53 A record with an UPSERT.
- [ ] Use a low but reasonable DNS TTL.
- [ ] Fail visibly when the DNS update cannot be completed.
- [ ] Never use IMDSv1.

### Idle checker installation

- [ ] Copy idle-check.sh to a stable executable path.
- [ ] Set secure ownership and permissions.
- [ ] Register it to run every five minutes.
- [ ] Prevent overlapping executions using flock or an equivalent mechanism.
- [ ] Ensure its environment includes the AWS CLI and mcrcon paths.

### Server readiness notification

- [ ] Monitor the server log for GTNH's completed-startup marker.
- [ ] Allow at least 10 minutes before declaring startup failure.
- [ ] Avoid sending duplicate online notifications after reboots or service restarts.
- [ ] Retrieve the Discord webhook URL securely.
- [ ] Post:

```text
🟢 Server is online! Connect at your.hostname:25565
```

- [ ] Include basic failure logging when the webhook call fails.

## 7. Implement server/idle-check.sh

### Player detection

- [ ] Query RCON on localhost using mcrcon.
- [ ] Retrieve the RCON password securely.
- [ ] Run the list command.
- [ ] Parse the current player count robustly.
- [ ] Treat an unavailable RCON endpoint as server not ready, not automatically empty.
- [ ] Avoid starting the idle timer during initial boot.
- [ ] Avoid stopping the instance while the Minecraft service is still starting.

### Empty-server timer

- [ ] Store the first-empty timestamp under /var/run.
- [ ] On the first empty result, create the timestamp file.
- [ ] On subsequent empty results, calculate elapsed empty time.
- [ ] Reset the timestamp whenever one or more players are present.
- [ ] Reset stale state after service restarts where appropriate.
- [ ] Require at least 1500 seconds continuously empty.

### Graceful shutdown

- [ ] When the empty duration reaches 25 minutes:
	- [ ] Post:

```text
💤 Server was empty for 25 min — shutting down to save costs.
```

	- [ ] Run save-all via RCON.
	- [ ] Optionally wait for save confirmation or a short save-completion delay.
	- [ ] Run stop via RCON.
	- [ ] Wait approximately 30 seconds.
	- [ ] Confirm the Minecraft process has exited.
	- [ ] Retrieve the instance ID using IMDSv2.
	- [ ] Determine the AWS region safely.
	- [ ] Call aws ec2 stop-instances.
	- [ ] Prevent repeated stop requests.
	- [ ] Log all shutdown actions.

## 8. Implement ControlStack

### Wake Lambda

- [ ] Create lambda/wake/index.ts.
- [ ] Use AWS SDK v3.
- [ ] Identify the single server instance safely.
- [ ] Prefer a known instance ID passed through environment variables.
- [ ] Optionally verify the Role=gtnh-server tag.
- [ ] Read the current instance state.
- [ ] If stopped, call StartInstances.
- [ ] If already pending, return starting.
- [ ] If already running, return already running.
- [ ] Handle stopping or shutting-down states explicitly.
- [ ] Return immediately rather than waiting for Minecraft readiness.
- [ ] Post:

```text
⏳ Instance launching…
```

- [ ] Return structured JSON.
- [ ] Add least-privilege IAM for the one instance.
- [ ] Add logs without leaking secrets.

### Stop Lambda

- [ ] Create lambda/stop/index.ts.
- [ ] Do not call StopInstances immediately.
- [ ] Use AWS Systems Manager Run Command or another secure mechanism to execute a graceful shutdown on the instance.
- [ ] Run save-all.
- [ ] Run stop.
- [ ] Wait for the server process to exit or for a bounded timeout.
- [ ] Then call StopInstances only when needed.
- [ ] Handle an already-stopped instance safely.
- [ ] Post:

```text
🛑 Server stopped.
```

- [ ] Give the Lambda enough timeout for graceful shutdown.
- [ ] Grant:
	- [ ] ssm:SendCommand
	- [ ] ssm:GetCommandInvocation
	- [ ] Scoped EC2 stop permissions
- [ ] Attach the SSM managed instance policy or equivalent minimum permissions to EC2.
- [ ] Ensure SSM works without requiring inbound SSH.

### Optional control API

- [ ] Create an HTTP API only when enabled by configuration.
- [ ] Protect non-Discord control endpoints.
- [ ] Do not rely solely on a static API key for high-risk operations without additional controls.
- [ ] Keep this path secondary to Discord.

## 9. Implement DiscordStack

### Secret and parameter references

- [ ] Provide secure references for:
	- [ ] Discord application ID
	- [ ] Discord application public key
	- [ ] Discord bot token
	- [ ] Discord webhook URL
	- [ ] RCON password
	- [ ] Minecraft hostname
	- [ ] Optional Discord channel configuration
- [ ] Do not hardcode any values.

### Interaction API

- [ ] Create an API Gateway HTTP endpoint.
- [ ] Route Discord interaction requests to the Discord Lambda.
- [ ] Preserve the raw request body.
- [ ] Ensure headers are available without normalization issues.
- [ ] Configure the endpoint URL as a stack output.
- [ ] Document that the URL must be pasted into Discord's Interactions Endpoint URL field.

### Discord interaction Lambda

- [ ] Create lambda/discord/index.ts.
- [ ] Read:
	- [ ] X-Signature-Ed25519
	- [ ] X-Signature-Timestamp
	- [ ] Raw request body
- [ ] Verify every request with Ed25519.
- [ ] Use tweetnacl or a verified equivalent.
- [ ] Reject invalid signatures with HTTP 401.
- [ ] Do not parse or act on the payload before signature verification.
- [ ] Respond to Discord PING/type 1 with PONG/type 1.

### /start

- [ ] Recognize the /start application command.
- [ ] Respond within Discord's three-second deadline.
- [ ] Use a deferred interaction response where appropriate.
- [ ] Invoke the Wake Lambda asynchronously or directly through AWS SDK.
- [ ] Reply with:

```text
🟢 Starting the GTNH server… this takes 3-5 minutes. I'll post here when it's ready.
```

- [ ] Do not block while EC2 or Minecraft boots.
- [ ] Ensure the later online message comes from the instance readiness check.

### /stop

- [ ] Recognize the /stop command.
- [ ] Invoke the Stop Lambda.
- [ ] Reply:

```text
🛑 Stopping the server gracefully and saving the world…
```

- [ ] Do not report stopped until graceful shutdown completes.

### /status

- [ ] Retrieve the instance state.
- [ ] Report stopped, pending, running, stopping, or error states clearly.
- [ ] When running, query player count securely.
- [ ] Prefer SSM Run Command rather than exposing RCON.
- [ ] Include:
	- [ ] EC2 state
	- [ ] Minecraft readiness
	- [ ] Player count
	- [ ] Maximum players: 3
	- [ ] Connect hostname
- [ ] Distinguish EC2 running from Minecraft ready.
- [ ] Tolerate the 3-5 minute startup period.

### Discord follow-up handling

- [ ] Store interaction tokens only for as long as required.
- [ ] Use Discord follow-up endpoints correctly.
- [ ] Handle expired tokens.
- [ ] Avoid logging bot tokens, webhook URLs, or interaction tokens.
- [ ] Return valid Discord response payloads for all command paths.

## 10. Register Discord commands

- [ ] Add a script or documented command-registration process.
- [ ] Register:
	- [ ] /start
	- [ ] /stop
	- [ ] /status
- [ ] Use guild commands during development for faster propagation.
- [ ] Support global command registration for production.
- [ ] Document required Discord application scopes and bot permissions.
- [ ] Document the one-time developer-portal setup.

## 11. Add observability and operational safeguards

- [ ] Create CloudWatch log groups with explicit retention periods.
- [ ] Log EC2 bootstrap failures.
- [ ] Log Lambda command requests and outcomes.
- [ ] Do not log secrets.
- [ ] Add a CloudWatch alarm for repeated Lambda errors.
- [ ] Add an alarm or budget for unexpected EC2 runtime.
- [ ] Create an AWS Budget around an expected monthly threshold.
- [ ] Notify when projected spend exceeds the chosen amount.
- [ ] Consider an EventBridge rule that detects instances left running unusually long.
- [ ] Do not auto-stop merely because a cost alarm fires unless graceful shutdown is guaranteed.
- [ ] Add an EC2 state-change notification path where useful.

## 12. Optimize for the expected workload

- [ ] Intended workload:
	- [ ] 2-3 concurrent players maximum
	- [ ] World and local backups currently about 4-10 GB
	- [ ] Server stopped most of the time
	- [ ] GTNH's 6 GB heap remains mandatory
- [ ] Implement these workload-specific settings:
	- [ ] max-players=3
	- [ ] 30 GB world EBS volume
	- [ ] 16 GB root volume
	- [ ] No NAT gateway
	- [ ] No Elastic IP
	- [ ] On-Demand instance initially
	- [ ] Auto-stop after 25 empty minutes
	- [ ] Five-minute player-count polling
	- [ ] No automatic downsize below 8 GB RAM
	- [ ] No ARM migration
	- [ ] Do not replace m6i.large with a burstable T-family instance without performance testing

## 13. Test infrastructure behavior

### CDK tests

- [ ] Verify no NAT gateway is created.
- [ ] Verify no Elastic IP is created.
- [ ] Verify the instance type is m6i.large.
- [ ] Verify root storage is 16 GB gp3.
- [ ] Verify world storage is 30 GB gp3.
- [ ] Verify the world volume has a retain policy.
- [ ] Verify port 25565 is public.
- [ ] Verify SSH is restricted.
- [ ] Verify RCON is not public.
- [ ] Verify IMDSv2 is required.
- [ ] Verify DLM is configured.
- [ ] Verify IAM resources are scoped.

### Lambda unit tests

- [ ] Test valid and invalid Discord signatures.
- [ ] Test Discord PING.
- [ ] Test /start.
- [ ] Test /stop.
- [ ] Test /status.
- [ ] Test stopped, pending, running, and stopping EC2 states.
- [ ] Test repeated /start requests.
- [ ] Test repeated /stop requests.
- [ ] Test unavailable RCON/SSM responses.
- [ ] Test malformed interaction payloads.
- [ ] Test missing secret values.

### Shell-script tests

- [ ] Test a blank EBS volume.
- [ ] Test an already-formatted EBS volume.
- [ ] Confirm existing world data is never reformatted.
- [ ] Test a failed mount.
- [ ] Test missing server files.
- [ ] Test missing RCON password.
- [ ] Test zero players.
- [ ] Test one player.
- [ ] Test malformed mcrcon list output.
- [ ] Test RCON unavailable during startup.
- [ ] Test the 25-minute threshold.
- [ ] Test save and stop sequencing.
- [ ] Test IMDSv2 metadata retrieval.

## 14. Perform manual GTNH validation

- [ ] Before fully automating:
	- [ ] Deploy the network and EC2 resources.
	- [ ] Attach and mount the 30 GB world volume.
	- [ ] Manually install the exact GTNH server version.
	- [ ] Confirm the required Java version against GTNH documentation for that pack version.
	- [ ] Start the server using exactly:

```bash
java -Xms6G -Xmx6G -Dfml.readTimeout=180 @java9args.txt -jar lwjgl3ify-forgePatches.jar nogui
```

	- [ ] Connect with 2-3 players.
	- [ ] Generate or load representative chunks.
	- [ ] Check TPS and tick times.
	- [ ] Observe memory usage.
	- [ ] Confirm the OS has adequate headroom outside the 6 GB heap.
	- [ ] Confirm there is no swapping under normal play.
	- [ ] Confirm boot completes within expected tolerances.
	- [ ] Retain m6i.large unless actual performance data shows it is insufficient.

## 15. Validate the complete lifecycle

- [ ] Run /start.
- [ ] Receive the immediate Discord acknowledgment.
- [ ] Receive Instance launching.
- [ ] Confirm Route 53 updates to the new public IP.
- [ ] Confirm Minecraft becomes ready after 3-5 minutes.
- [ ] Receive the Server is online message.
- [ ] Connect using the hostname.
- [ ] Verify three-player limit behavior.
- [ ] Verify /status reports state and players accurately.
- [ ] Disconnect all players.
- [ ] Confirm the empty timer starts.
- [ ] Reconnect before 25 minutes and confirm the timer resets.
- [ ] Disconnect again.
- [ ] Confirm graceful shutdown after 25 continuous empty minutes.
- [ ] Confirm save-all occurs before stop.
- [ ] Confirm the EC2 instance stops.
- [ ] Confirm the EBS volume remains attached/preserved.
- [ ] Start again and verify the world persists.
- [ ] Confirm daily snapshots are created.
- [ ] Test manual /stop.
- [ ] Restore a snapshot in a non-production test before relying on backups.

## 16. Write the README

- [ ] Document:
	- [ ] Architecture overview
	- [ ] Expected workload: 2-3 players
	- [ ] Why m6i.large is used
	- [ ] Why the volume is 30 GB despite a current 4-10 GB world
	- [ ] Why RCON is localhost-only
	- [ ] Why there is no NAT gateway
	- [ ] Why there is no Elastic IP
	- [ ] Required AWS prerequisites
	- [ ] Required Route 53 domain setup
	- [ ] CDK bootstrap instructions
	- [ ] Installation commands
	- [ ] All CDK context values
	- [ ] How to create or populate SSM parameters
	- [ ] How to upload initial server/world files
	- [ ] How to identify the EBS volume safely
	- [ ] Discord application setup
	- [ ] Discord command registration
	- [ ] Setting the Interactions Endpoint URL
	- [ ] How to deploy
	- [ ] How to destroy stateless infrastructure without deleting the world
	- [ ] How to restore an EBS snapshot
	- [ ] How to update the GTNH server version
	- [ ] How to rotate Discord and RCON secrets
	- [ ] How to enable Spot later
	- [ ] Troubleshooting slow GTNH startup
	- [ ] Troubleshooting Route 53 updates
	- [ ] Troubleshooting EBS mounts
	- [ ] Troubleshooting SSM and RCON
	- [ ] Estimated cost behavior:
		- [ ] Low fixed cost while stopped
		- [ ] Compute dominates while running
		- [ ] An instance accidentally left running is the primary billing risk

## 17. Final acceptance criteria

- [ ] npm ci completes successfully.
- [ ] npm run build passes.
- [ ] Tests pass.
- [ ] cdk synth passes.
- [ ] cdk deploy --all provisions the infrastructure.
- [ ] Only secrets, initial world upload, Discord command registration, and the Interactions Endpoint URL require manual setup.
- [ ] /start starts the EC2 instance.
- [ ] Discord acknowledges within three seconds.
- [ ] Discord reports when Minecraft is actually ready.
- [ ] Two to three players can connect and play at acceptable TPS.
- [ ] /status reports accurate server and player state.
- [ ] /stop performs a graceful save and shutdown.
- [ ] Empty-server shutdown occurs after 25 minutes.
- [ ] The instance is stopped whenever unused.
- [ ] World data survives stop/start.
- [ ] World data survives EC2 replacement.
- [ ] Daily snapshots exist and can be restored.
- [ ] No RCON port is publicly exposed.
- [ ] No NAT gateway or Elastic IP generates unnecessary recurring charges.
- [ ] No secret is committed to source control.

---

Status: TODO template added. No infrastructure actions executed.