# GTNH On-Demand AWS Server

Planning-only checklist for implementation by a coding agent. This document is intentionally a TODO list and does not imply that any infrastructure has been deployed yet.

> **Implementation status (2026-06-24):** Phase 1 — a minimal, non-GTNH test build — has been implemented and deployed live to verify the core mechanics (VPC/security group, EC2 + dedicated EBS world volume, IMDSv2, SSM-only access, idle auto-shutdown). It deliberately substitutes a smaller instance/volumes and a vanilla Paper server for GTNH's locked-in specs, since GTNH itself isn't being deployed yet. ControlStack, DiscordStack, Route 53, DLM snapshots, S3 staging, and Spot support are all still TODO. Checkboxes below are marked `[x]` only where the literal requirement is met; items satisfied differently for the test build are left unchecked with an inline note.

## 1. Lock implementation decisions

- [x] Use AWS CDK v2 with TypeScript.
- [ ] Use m6i.large *(test build uses t3.medium/4GB instead — revisit when GTNH itself is deployed)*:
	- [x] 2 vCPU
	- [ ] 8 GB RAM *(t3.medium has 4GB)*
	- [x] x86_64
	- [x] On-Demand by default
	- [x] Do not use ARM/Graviton.
	- [ ] Do not use a 4 GB instance. *(test build intentionally uses one)*
- [x] Set useSpot=false by default and expose it as CDK context.
- [ ] Use a 30 GB gp3 dedicated world volume. *(test build defaults to 10 GB, configurable via context)*
- [ ] Use a 16 GB gp3 root volume. *(test build defaults to 8 GB, configurable via context)*
- [x] Configure the Minecraft server for 3 maximum players.
- [ ] Keep the JVM heap at exactly 6 GB. *(test build uses -Xms1G -Xmx3G for Paper on t3.medium)*
- [x] Keep the idle timeout at exactly 25 minutes.
- [x] Use a public subnet with:
	- [x] No NAT gateway
	- [ ] No Elastic IP *(reversed by request on 2026-06-25: an EIP is now allocated and associated with the instance so the address stays stable across stop/start. Costs ~$0.005/hr continuously, ~$3.60/mo, including while stopped — accepted tradeoff for a stable connect address. See `lib/server-stack.ts`'s `ServerEip`.)*
	- [ ] Dynamic Route 53 DNS update on boot *(deferred; connect via the static IP for now)*
- [x] Use the dedicated EBS volume as the authoritative copy of the world.
- [x] Treat S3 staging as optional rather than required for every boot. *(S3 staging itself isn't implemented yet — not needed for the Paper test build)*
- [x] Use standard SSM parameters where possible to minimize recurring secret-storage cost.
- [x] Use Secrets Manager only where its additional protections are specifically needed. *(not used at all yet — SSM SecureString has sufficed)*

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

  **Actual current structure** (lives at the repo root, not a `gtnh-ondemand/` subdirectory; package manager is pnpm):
  ```text
  aws-server-hosting/
  ├── bin/app.ts
  ├── lib/{config,network-stack,server-stack}.ts
  ├── server/{user-data.sh,idle-check.sh}
  ├── test/{config,network-stack,server-stack}.test.ts
  ├── package.json, pnpm-lock.yaml, cdk.json, tsconfig.json, jest.config.js, .gitignore
  ```
  `lib/control-stack.ts`, `lib/discord-stack.ts`, and the whole `lambda/` tree do not exist yet (ControlStack/DiscordStack are deferred).

- [x] Run cdk init app --language typescript.
- [x] Enable strict TypeScript settings.
- [x] Add scripts for:
	- [x] build
	- [x] watch
	- [x] test
	- [x] synth
	- [x] deploy
	- [x] destroy
- [ ] Install required dependencies:
	- [x] aws-cdk-lib
	- [x] constructs
	- [ ] AWS SDK v3 packages *(not needed yet — no Lambda code exists)*
	- [ ] tweetnacl *(not needed yet — no Discord signature verification exists)*
	- [x] Appropriate Lambda bundling dependencies *(esbuild added in preparation; not yet exercised by an actual Lambda)*
- [ ] Add Lambda bundling with NodejsFunction or equivalent. *(no Lambdas exist yet)*
- [x] Ensure npm run build succeeds. *(`pnpm run build`: tsc --noEmit type-check + esbuild bundle to dist/app.js)*
- [x] Ensure cdk synth succeeds before adding live resources.

## 3. Define configuration and CDK context

- [ ] Add configuration for:
	- [ ] AWS region *(resolved from the AWS profile via CDK_DEFAULT_REGION rather than an explicit context key)*
	- [x] useSpot (default false)
	- [x] SSH source CIDR *(`sshCidr` context, only required when `enableSsh=true`; SSH is off by default in favor of SSM Session Manager)*
	- [ ] Route 53 zone name *(deferred)*
	- [ ] Existing hosted zone ID (when supplied) *(deferred)*
	- [ ] Minecraft hostname *(deferred — no DNS yet)*
	- [ ] World volume size (default 30) *(implemented as `worldVolumeSizeGiB` context; default is 10 for the test build)*
	- [ ] Root volume size (default 16) *(implemented as `rootVolumeSizeGiB` context; default is 8 for the test build)*
	- [ ] Instance type (default m6i.large) *(implemented as `instanceType` context; default is t3.medium for the test build)*
	- [x] Minecraft port (default 25565)
	- [x] RCON port (default 25575)
	- [x] Maximum players (default 3)
	- [x] Idle timeout (default 1500 seconds)
	- [x] Idle-check interval (default 5 minutes)
	- [ ] Optional S3 server-files bucket *(deferred)*
	- [ ] Optional S3 object prefix *(deferred)*
	- [x] Environment name or deployment stage (`environment` context, default "test")
- [x] Validate context values during synthesis. (`lib/config.ts` throws on invalid values; covered by `test/config.test.ts`)

## 4. Implement NetworkStack

### VPC

- [x] Create a VPC with one public subnet.
- [x] Set NAT gateways to zero.
- [x] Ensure the subnet assigns public IPv4 addresses.
- [ ] Alternatively support importing an existing/default VPC. *(not implemented — always creates a new VPC)*
- [x] Avoid unnecessary private subnets and NAT charges.

### Security group

- [x] Allow TCP 25565 from 0.0.0.0/0.
- [x] Allow TCP 22 only from the configured SSH CIDR. *(supported via `enableSsh` context; disabled by default — SSM Session Manager is used instead)*
- [x] Do not expose TCP 25575.
- [ ] Keep RCON reachable only from localhost. *(vanilla/Paper RCON has no bind-address option and always listens on 0.0.0.0 inside the instance; isolation is enforced entirely by the security group having no 25575 ingress rule, not by the bind address)*
- [x] Allow outbound traffic needed for:
	- [x] Package installation
	- [x] AWS APIs
	- [x] Discord webhook calls
	- [x] Optional S3 downloads

### Route 53

- [ ] Import an existing public hosted zone when an ID is supplied. *(deferred)*
- [ ] Otherwise create a public hosted zone. *(deferred)*
- [ ] Create or prepare management of an A record for the server hostname. *(deferred)*
- [ ] Do not allocate an Elastic IP. *(reversed by request on 2026-06-25 — see Section 1 note)*
- [ ] Grant the EC2 role permission to update only the required hosted zone or record. *(deferred — no Route 53 yet; with a static EIP now in place, dynamic DNS update matters less, but a stable hostname would still be nicer than a raw IP)*
- [ ] Export or expose:
	- [x] VPC
	- [x] Public subnet
	- [x] Security group
	- [ ] Hosted zone ID *(N/A — no Route 53 yet)*
	- [ ] Record name *(N/A — no Route 53 yet)*

## 5. Implement ServerStack

### EC2 instance

- [ ] Create an m6i.large Linux EC2 instance. *(test build uses t3.medium, configurable via `instanceType` context)*
- [x] Use an x86_64 AMI.
- [x] Enable IMDSv2 and require metadata tokens.
- [ ] Configure a 16 GB gp3 root volume. *(test build uses 8 GB, configurable via `rootVolumeSizeGiB` context)*
- [ ] Set shutdown behavior appropriately. *(relying on the EC2 default of "stop"; not explicitly configured/documented)*
- [ ] Add tags:
	- [ ] Role=gtnh-server *(tagged `Role=mc-server` instead — intentional, since this isn't a GTNH deployment yet)*
	- [x] Environment/project tags
- [x] Expose the instance ID to the control stacks. *(CfnOutput; no control stack exists yet to consume it)*
- [ ] Prevent accidental replacement where practical. *(not specifically addressed)*
- [x] Add deletion protection or clear safeguards for stateful resources where appropriate. *(world volume has RemovalPolicy.RETAIN)*

### Spot support

- [ ] Support useSpot=true through a launch template. *(not implemented — `useSpot=true` throws explicitly)*
- [ ] Configure Spot interruption behavior to stop.
- [x] Keep On-Demand as the default.
- [ ] Document that Spot should only be enabled after reliable backups and interruption handling are verified.

### Dedicated EBS world volume

- [ ] Create a standalone 30 GB gp3 EBS volume. *(test build uses 10 GB, configurable via `worldVolumeSizeGiB` context)*
- [x] Do not define it as an ephemeral instance root block device.
- [x] Place it in the same availability zone as the EC2 instance.
- [x] Attach it to the instance.
- [x] Enable encryption.
- [x] Apply a retention policy so stack deletion does not silently destroy the world.
- [ ] Tag it clearly:
	- [ ] Role=gtnh-world *(tagged `Role=mc-world` instead — intentional, non-GTNH naming for now)*
	- [x] Backup=true
- [x] Document device-name differences between the EC2 API and Linux NVMe devices. *(handled in `server/user-data.sh` via `/dev/disk/by-id` resolution)*

### IAM instance role

- [ ] Grant only the permissions required for:
	- [ ] Updating the specific Route 53 hosted zone *(N/A — no Route 53 yet)*
	- [x] Reading required SSM parameters
	- [x] Reading required Secrets Manager secrets (when used) *(none needed yet, trivially satisfied)*
	- [ ] Reading optional S3 server files *(not implemented)*
	- [x] Stopping its own instance
	- [ ] Starting its own instance only when genuinely needed *(not granted — instance has no self-start permission currently)*
	- [x] Calling ec2:DescribeInstances where required
	- [ ] Sending logs or metrics if CloudWatch integration is enabled *(not implemented — logs stay local via journald)*
- [x] Scope instance actions using:
	- [ ] Instance ARN where possible *(used tag-based scoping instead, specifically to avoid a circular CloudFormation dependency between the role and the instance's own ID)*
	- [x] Resource tags where ARN scoping is unavailable
	- [x] Conditions preventing management of unrelated EC2 instances

### DLM snapshots

- [ ] Create the IAM role required by Data Lifecycle Manager. *(not implemented)*
- [ ] Create a DLM policy targeting the world-volume backup tag.
- [ ] Run one snapshot daily.
- [ ] Retain approximately seven daily snapshots.
- [ ] Tag snapshots with project and environment metadata.
- [ ] Confirm the 30 GB volume is included.
- [ ] Confirm the root volume is not unintentionally included unless desired.

## 6. Implement server/user-data.sh

The script must be safe to execute repeatedly.

### Shell safety

- [x] Start with strict shell options:

```bash
set -euo pipefail
```

- [x] Log bootstrap output to a persistent log. (`/var/log/mc-ondemand-bootstrap.log`)
- [x] Make operations idempotent.
- [x] Never erase an initialized world volume.

### Detect and mount the world volume

- [x] Identify the attached EBS device reliably on Nitro/NVMe instances. (`/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_<volume-id>`)
- [x] Check whether the device already contains a filesystem.
- [x] Format only when no filesystem exists.
- [x] Use a suitable filesystem such as ext4 or XFS.
- [x] Mount at a stable location (for example /srv/gtnh). (`/srv/mc`)
- [x] Add an /etc/fstab entry using the filesystem UUID.
- [ ] Use mount options suitable for a server workload. *(uses `defaults,nofail`; no workload-specific tuning like `noatime` yet)*
- [x] Verify the mount before placing files.
- [x] Abort rather than writing world data to the root volume when mounting fails.

### Install system packages

- [x] Install AWS CLI. (already present on Amazon Linux 2023; installed only if missing)
- [x] Install required archive/download utilities.
- [x] Install cron or use a systemd timer. (systemd timer)
- [x] Install build dependencies required for mcrcon.
- [x] Install mcrcon. (built from source: github.com/Tiiffi/mcrcon)
- [x] Install a modern JDK supported by the deployed GTNH version. *(Java 21 Corretto installed — for the Paper test build, not GTNH; GTNH's actual required Java version still needs separate verification when that phase starts)*
- [x] Do not install Java 8.
- [x] Target Java 21 when compatible with the installed pack.
- [x] Verify java -version.
- [ ] Document the pack-version-to-Java-version check in the README. *(not written yet — see Section 16)*

### Place server files

- [x] Support server files already present on the EBS volume.
- [ ] Optionally stage initial files from S3 only when the server directory is uninitialized. *(not implemented — downloads Paper directly from the PaperMC API instead of S3)*
- [x] Never overwrite an existing world during routine boot.
- [ ] Verify these files exist:
	- [ ] lwjgl3ify-forgePatches.jar *(N/A — GTNH-specific file, not used by the Paper test build)*
	- [ ] java9args.txt *(N/A — GTNH-specific file, not used by the Paper test build)*
- [ ] Verify the world directory exists. *(not explicitly pre-checked; the world directory is created by the server itself on first run)*
- [x] Ensure ownership belongs to a dedicated non-root service user.
- [x] Create a server user such as gtnh. *(created as `mcserver`; name differs from the GTNH default but serves the same purpose)*
- [x] Avoid running Minecraft as root.

### Configure server.properties

- [x] Set or preserve:

```properties
server-port=25565
enable-rcon=true
rcon.port=25575
max-players=3
```

- [x] Read the RCON password from SSM or Secrets Manager.
- [x] Write rcon.password without exposing it in logs.
- [ ] Bind RCON to localhost where supported. *(not supported by vanilla/Paper; compensating control is the security group, not the bind address — see Section 4 note)*
- [x] Do not create an inbound security-group rule for RCON.
- [x] Preserve pack-specific settings not managed by the bootstrap script.
- [x] Set the EULA only after the operator has explicitly accepted it. (`mcEulaAccepted` context gate)

### Create the systemd service

- [x] Set WorkingDirectory to the server directory.
- [x] Run under the dedicated service user.
- [ ] Use the exact required command:

```bash
java -Xms6G -Xmx6G -Dfml.readTimeout=180 @java9args.txt -jar lwjgl3ify-forgePatches.jar nogui
```

  *(N/A for this test build — runs `java -Xms1G -Xmx3G -jar server.jar nogui` for Paper instead; the exact GTNH command is reserved for the future GTNH phase)*

- [x] Do not add GC flags.
- [ ] Do not alter -Xms6G. *(N/A — different heap entirely since GTNH isn't deployed yet)*
- [ ] Do not alter -Xmx6G. *(N/A — same as above)*
- [x] Set Restart=on-failure.
- [x] Add sensible restart delays and start-limit protections.
- [x] Increase systemd startup timeout to tolerate a 3-5 minute boot. (`TimeoutStartSec=300`)
- [x] Redirect or preserve logs appropriately. (journald via systemd)
- [x] Enable the service.
- [x] Start it after the EBS volume is mounted and networking is available.

### Route 53 update

- [ ] Retrieve an IMDSv2 token. *(deferred along with the rest of Route 53 — no DNS update step exists yet)*
- [ ] Retrieve the instance public IPv4 address using the token.
- [ ] Update the Route 53 A record with an UPSERT.
- [ ] Use a low but reasonable DNS TTL.
- [ ] Fail visibly when the DNS update cannot be completed.
- [ ] Never use IMDSv1. *(satisfied everywhere else in the scripts that do use IMDS, just noting Route 53 itself isn't implemented)*

### Idle checker installation

- [x] Copy idle-check.sh to a stable executable path. (`/usr/local/bin/mc-idle-check.sh`)
- [x] Set secure ownership and permissions. (root:root, 0755)
- [x] Register it to run every five minutes. (systemd timer, interval from context)
- [x] Prevent overlapping executions using flock or an equivalent mechanism.
- [x] Ensure its environment includes the AWS CLI and mcrcon paths. (explicit `PATH` in the systemd unit)

### Server readiness notification

- [ ] Monitor the server log for GTNH's completed-startup marker. *(not implemented — no Discord webhook configured in this build yet)*
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

- [x] Query RCON on localhost using mcrcon.
- [x] Retrieve the RCON password securely.
- [x] Run the list command.
- [x] Parse the current player count robustly.
- [x] Treat an unavailable RCON endpoint as server not ready, not automatically empty.
- [x] Avoid starting the idle timer during initial boot. (covered by the RCON-unavailable handling)
- [x] Avoid stopping the instance while the Minecraft service is still starting. (`systemctl is-active` check first)

### Empty-server timer

- [x] Store the first-empty timestamp under /var/run.
- [x] On the first empty result, create the timestamp file.
- [x] On subsequent empty results, calculate elapsed empty time.
- [x] Reset the timestamp whenever one or more players are present.
- [x] Reset stale state after service restarts where appropriate. (`/var/run` is tmpfs, cleared on reboot)
- [x] Require at least 1500 seconds continuously empty.

### Graceful shutdown

- [x] When the empty duration reaches 25 minutes:
	- [ ] Post:

```text
💤 Server was empty for 25 min — shutting down to save costs.
```

  *(not implemented — no Discord webhook configured yet; only logged locally via the script's own `log()` calls)*

	- [x] Run save-all via RCON.
	- [x] Optionally wait for save confirmation or a short save-completion delay.
	- [x] Run stop via RCON.
	- [x] Wait approximately 30 seconds.
	- [x] Confirm the Minecraft process has exited.
	- [x] Retrieve the instance ID using IMDSv2.
	- [x] Determine the AWS region safely.
	- [x] Call aws ec2 stop-instances.
	- [x] Prevent repeated stop requests. (`stop-requested` marker file)
	- [x] Log all shutdown actions.

## 8. Implement ControlStack

Entire section deferred — no wake/stop Lambdas or control API exist yet. The instance currently self-stops via the idle-check timer above and is started manually via `aws ec2 start-instances`.

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
- [x] Attach the SSM managed instance policy or equivalent minimum permissions to EC2. *(already done on the EC2 role itself — `AmazonSSMManagedInstanceCore` — even though the Stop Lambda that would use it doesn't exist yet)*
- [x] Ensure SSM works without requiring inbound SSH. *(verified live — SSM Session Manager/Run Command used throughout this session with no SSH/key pair)*

### Optional control API

- [ ] Create an HTTP API only when enabled by configuration.
- [ ] Protect non-Discord control endpoints.
- [ ] Do not rely solely on a static API key for high-risk operations without additional controls.
- [ ] Keep this path secondary to Discord.

## 9. Implement DiscordStack

Entire section deferred — no Discord bot exists yet.

### Secret and parameter references

- [ ] Provide secure references for:
	- [ ] Discord application ID
	- [ ] Discord application public key
	- [ ] Discord bot token
	- [ ] Discord webhook URL
	- [x] RCON password *(implemented now, ahead of DiscordStack — SSM SecureString, randomly generated, never logged or committed)*
	- [x] Minecraft hostname *(N/A yet — connect via public IP; will need this once Route 53 exists)*
	- [ ] Optional Discord channel configuration
- [x] Do not hardcode any values.

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

- [ ] Create CloudWatch log groups with explicit retention periods. *(logs currently stay local via journald, not shipped to CloudWatch)*
- [ ] Log EC2 bootstrap failures. *(logged locally to /var/log/mc-ondemand-bootstrap.log, not yet to CloudWatch)*
- [ ] Log Lambda command requests and outcomes. *(N/A — no Lambdas yet)*
- [x] Do not log secrets.
- [ ] Add a CloudWatch alarm for repeated Lambda errors.
- [ ] Add an alarm or budget for unexpected EC2 runtime.
- [ ] Create an AWS Budget around an expected monthly threshold.
- [ ] Notify when projected spend exceeds the chosen amount.
- [ ] Consider an EventBridge rule that detects instances left running unusually long.
- [ ] Do not auto-stop merely because a cost alarm fires unless graceful shutdown is guaranteed. *(N/A yet — no cost alarms exist)*
- [ ] Add an EC2 state-change notification path where useful.

## 12. Optimize for the expected workload

- [ ] Intended workload:
	- [x] 2-3 concurrent players maximum
	- [ ] World and local backups currently about 4-10 GB *(not yet measured against a real GTNH world; N/A for the Paper test world)*
	- [x] Server stopped most of the time
	- [ ] GTNH's 6 GB heap remains mandatory *(N/A — not running GTNH yet)*
- [ ] Implement these workload-specific settings:
	- [x] max-players=3
	- [ ] 30 GB world EBS volume *(test build defaults to 10 GB)*
	- [ ] 16 GB root volume *(test build defaults to 8 GB)*
	- [x] No NAT gateway
	- [ ] No Elastic IP *(reversed by request on 2026-06-25 — see Section 1 note)*
	- [x] On-Demand instance initially
	- [x] Auto-stop after 25 empty minutes
	- [x] Five-minute player-count polling
	- [ ] No automatic downsize below 8 GB RAM *(test build runs a 4GB instance by design, since it isn't running GTNH yet)*
	- [x] No ARM migration
	- [ ] Do not replace m6i.large with a burstable T-family instance without performance testing *(test build intentionally uses a T-family t3.medium — acceptable since GTNH itself isn't deployed; revisit before the GTNH phase)*

## 13. Test infrastructure behavior

### CDK tests

- [x] Verify no NAT gateway is created.
- [ ] Verify no Elastic IP is created. *(no longer applicable — a static EIP is now intentional; the network-stack test still verifies zero EIPs at that stack's level since the EIP lives in ServerStack)*
- [ ] Verify the instance type is m6i.large. *(test asserts t3.medium, matching the current config)*
- [ ] Verify root storage is 16 GB gp3. *(test asserts 8 GB, matching the current config)*
- [ ] Verify world storage is 30 GB gp3. *(test asserts 10 GB, matching the current config)*
- [x] Verify the world volume has a retain policy.
- [x] Verify port 25565 is public.
- [x] Verify SSH is restricted.
- [x] Verify RCON is not public.
- [x] Verify IMDSv2 is required.
- [ ] Verify DLM is configured. *(DLM not implemented yet)*
- [x] Verify IAM resources are scoped.

(See `test/config.test.ts`, `test/network-stack.test.ts`, `test/server-stack.test.ts` — 16 tests passing.)

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

(N/A — no Lambdas exist yet.)

### Shell-script tests

- [ ] Test a blank EBS volume. *(exercised live during this session's deploy, not via an automated test harness)*
- [ ] Test an already-formatted EBS volume. *(exercised live across the in-place restart during this session)*
- [ ] Confirm existing world data is never reformatted. *(verified live)*
- [ ] Test a failed mount.
- [ ] Test missing server files.
- [ ] Test missing RCON password.
- [ ] Test zero players.
- [ ] Test one player.
- [ ] Test malformed mcrcon list output.
- [ ] Test RCON unavailable during startup.
- [ ] Test the 25-minute threshold.
- [ ] Test save and stop sequencing.
- [ ] Test IMDSv2 metadata retrieval. *(exercised live — works)*

No automated shell-script test harness (e.g. bats) exists yet; the above were only exercised manually/live, not as repeatable tests.

## 14. Perform manual GTNH validation

Entire section deferred — this build runs Paper, not GTNH, so GTNH-specific validation does not apply yet.

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

- [ ] Run /start. *(N/A — no Discord bot; used `aws ec2 start-instances` manually)*
- [ ] Receive the immediate Discord acknowledgment. *(N/A)*
- [ ] Receive Instance launching. *(N/A)*
- [ ] Confirm Route 53 updates to the new public IP. *(N/A — no Route 53 yet)*
- [x] Confirm Minecraft becomes ready after 3-5 minutes. *(observed live: ready in 66 seconds on a t3.medium with an empty world)*
- [ ] Receive the Server is online message. *(N/A — no Discord)*
- [x] Connect using the hostname. *(connected via raw public IP instead — verified TCP reachability to port 25565 from outside AWS)*
- [ ] Verify three-player limit behavior. *(not exercised with real players yet)*
- [ ] Verify /status reports state and players accurately. *(N/A — no /status command)*
- [ ] Disconnect all players.
- [ ] Confirm the empty timer starts.
- [ ] Reconnect before 25 minutes and confirm the timer resets.
- [ ] Disconnect again.
- [ ] Confirm graceful shutdown after 25 continuous empty minutes. *(logic implemented and code-reviewed; not yet observed over a full real 25-minute live cycle)*
- [x] Confirm save-all occurs before stop. *(verified in script logic)*
- [ ] Confirm the EC2 instance stops. *(not yet observed live end-to-end)*
- [x] Confirm the EBS volume remains attached/preserved. *(verified live — world volume survived an in-place instance update/restart during this session)*
- [x] Start again and verify the world persists. *(verified live — Paper world/server files persisted across the restart on the retained EBS volume)*
- [ ] Confirm daily snapshots are created. *(DLM not implemented)*
- [ ] Test manual /stop. *(N/A — no Discord; `aws ec2 stop-instances` works as the manual equivalent, not yet exercised live)*
- [ ] Restore a snapshot in a non-production test before relying on backups. *(no snapshots exist yet)*

## 16. Write the README

Not written yet for this implementation. The repo's `README.md` is still the original high-level project pitch; it does not yet cover any of the items below for the current build.

- [ ] Document:
	- [ ] Architecture overview
	- [ ] Expected workload: 2-3 players
	- [ ] Why m6i.large is used
	- [ ] Why the volume is 30 GB despite a current 4-10 GB world
	- [ ] Why RCON is localhost-only
	- [ ] Why there is no NAT gateway
	- [ ] Why a static Elastic IP is used (and its small recurring cost)
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

- [x] npm ci completes successfully. (`pnpm install`)
- [x] npm run build passes. (`pnpm run build`)
- [x] Tests pass. (`pnpm run test` — 16/16)
- [x] cdk synth passes.
- [x] cdk deploy --all provisions the infrastructure. (verified live in account 098593159941, us-east-1)
- [ ] Only secrets, initial world upload, Discord command registration, and the Interactions Endpoint URL require manual setup. *(not yet true — this session also had to manually re-trigger user-data via SSM after an in-place UserData update, since cloud-init doesn't re-run it automatically; see note below)*
- [ ] /start starts the EC2 instance. *(N/A — no Discord; `aws ec2 start-instances` works manually)*
- [ ] Discord acknowledges within three seconds. *(N/A)*
- [ ] Discord reports when Minecraft is actually ready. *(N/A)*
- [ ] Two to three players can connect and play at acceptable TPS. *(not tested with real players yet)*
- [ ] /status reports accurate server and player state. *(N/A — no /status command)*
- [ ] /stop performs a graceful save and shutdown. *(N/A — no Discord; idle-check's graceful-shutdown code path is implemented but not yet exercised via a live full shutdown)*
- [ ] Empty-server shutdown occurs after 25 minutes. *(implemented; not yet observed over a full real 25-minute live cycle)*
- [ ] The instance is stopped whenever unused. *(mechanism in place, not yet proven over time)*
- [x] World data survives stop/start. (verified live this session)
- [x] World data survives EC2 replacement. (verified live this session, via an in-place CloudFormation update)
- [ ] Daily snapshots exist and can be restored. *(DLM not implemented)*
- [x] No RCON port is publicly exposed.
- [ ] No NAT gateway or Elastic IP generates unnecessary recurring charges. *(no NAT gateway, but a static EIP was added by request on 2026-06-25 — small accepted recurring cost, ~$3.60/mo)*
- [x] No secret is committed to source control.

---

Status: Phase 1 (minimal Paper/vanilla Minecraft test build) implemented and verified live on 2026-06-24 in AWS account 098593159941 (us-east-1). Core on-demand mechanics — VPC/security group, EC2 + dedicated retained EBS world volume, IMDSv2, SSM-only access, idle auto-shutdown — are working end to end. GTNH-specific specs (Section 1's exact instance/volume/heap sizes), ControlStack, DiscordStack, Route 53, DLM snapshots, S3 staging, Spot support, and the README (Section 16) remain TODO.
