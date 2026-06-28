import * as fs from 'fs';
import * as path from 'path';
import { CfnOutput, Duration, RemovalPolicy, Size, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { AppConfig } from './config';

export interface ServerStackProps extends StackProps {
  readonly config: AppConfig;
  readonly vpc: ec2.Vpc;
  readonly securityGroup: ec2.SecurityGroup;
}

const MOUNT_POINT = '/srv/mc';
const SERVICE_USER = 'mcserver';

export class ServerStack extends Stack {
  public readonly instance: ec2.Instance;
  public readonly publicIp: string;
  public readonly importBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ServerStackProps) {
    super(scope, id, props);
    const { config, vpc, securityGroup } = props;

    const role = new iam.Role(this, 'ServerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DescribeAnyInstance',
        actions: ['ec2:DescribeInstances'],
        resources: ['*'],
      }),
    );

    // Scoped by tag instead of instance ARN to avoid a circular dependency
    // between the role (needed to launch the instance) and the instance's own ID.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SelfStopOnly',
        actions: ['ec2:StopInstances'],
        resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/*`],
        conditions: {
          StringEquals: { 'ec2:ResourceTag/Role': 'mc-server' },
        },
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadRconPasswordAndWebhook',
        actions: ['ssm:GetParameter'],
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: config.rconParameterName.replace(/^\//, ''),
          }),
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: config.discordWebhookParameterName.replace(/^\//, ''),
          }),
        ],
      }),
    );

    this.instance = new ec2.Instance(this, 'ServerInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup,
      instanceType: new ec2.InstanceType(config.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.X86_64 }),
      role,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(config.rootVolumeSizeGiB, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });
    Tags.of(this.instance).add('Role', 'mc-server');
    Tags.of(this.instance).add('Environment', config.environment);

    // Static IP so the address doesn't change across stop/start. Costs ~$0.005/hr
    // (~$3.60/mo) continuously, including while stopped, unlike the default
    // auto-assigned public IP which is free while the instance is stopped.
    //
    // Allocated standalone (no instanceId here) and associated via a separate
    // CfnEIPAssociation below, rather than associating at allocation time:
    // the instance's user-data embeds the EIP's address, so the EIP can't
    // also depend on the instance without a circular dependency.
    const eip = new ec2.CfnEIP(this, 'ServerEip', {
      domain: 'vpc',
    });
    Tags.of(eip).add('Environment', config.environment);

    new ec2.CfnEIPAssociation(this, 'ServerEipAssociation', {
      allocationId: eip.attrAllocationId,
      instanceId: this.instance.instanceId,
    });

    const worldVolume = new ec2.Volume(this, 'WorldVolume', {
      // Pinned directly from the VPC (single-AZ) rather than the instance's own
      // AZ attribute, which would create a circular dependency: the instance's
      // user-data embeds the volume ID, so the volume can't also depend on the instance.
      availabilityZone: vpc.availabilityZones[0],
      size: Size.gibibytes(config.worldVolumeSizeGiB),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    Tags.of(worldVolume).add('Role', 'mc-world');
    Tags.of(worldVolume).add('Backup', 'true');
    Tags.of(worldVolume).add('Environment', config.environment);

    new ec2.CfnVolumeAttachment(this, 'WorldVolumeAttachment', {
      instanceId: this.instance.instanceId,
      volumeId: worldVolume.volumeId,
      device: '/dev/sdf',
    });

    // Transient staging area for importing server/world files. The EBS world
    // volume remains the authoritative copy; this is just a transfer pipe
    // (local machine -> S3 -> instance), so objects expire automatically and
    // the bucket is fine to destroy with the stack.
    this.importBucket = new s3.Bucket(this, 'ImportBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
    });
    this.importBucket.grantRead(role);

    this.publicIp = eip.attrPublicIp;
    this.instance.userData.addCommands(
      ...this.renderUserData(config, worldVolume.volumeId, this.publicIp),
    );

    new CfnOutput(this, 'InstanceId', { value: this.instance.instanceId });
    new CfnOutput(this, 'PublicIp', { value: this.publicIp });
    new CfnOutput(this, 'ImportBucketName', { value: this.importBucket.bucketName });
  }

  private renderUserData(config: AppConfig, worldVolumeId: string, publicIp: string): string[] {
    const readScript = (name: string) =>
      fs.readFileSync(path.join(__dirname, '..', 'server', name), 'utf8');

    let bootScript = readScript('user-data.sh');
    // ec2.UserData.forLinux() already emits its own "#!/bin/bash" shebang.
    bootScript = bootScript.replace(/^#!.*\n/, '');

    const substitutions: Record<string, string> = {
      __MOUNT_POINT__: MOUNT_POINT,
      __SERVICE_USER__: SERVICE_USER,
      __WORLD_VOLUME_ID__: worldVolumeId,
      __MC_PORT__: String(config.minecraftPort),
      __RCON_PORT__: String(config.rconPort),
      __MAX_PLAYERS__: String(config.maxPlayers),
      __RCON_PARAM_NAME__: config.rconParameterName,
      __EULA_ACCEPTED__: String(config.mcEulaAccepted),
      __IDLE_TIMEOUT_SECONDS__: String(config.idleTimeoutSeconds),
      __IDLE_CHECK_INTERVAL_MINUTES__: String(config.idleCheckIntervalMinutes),
      __PAPER_MC_VERSION__: '1.21.4',
      __DISCORD_WEBHOOK_PARAM_NAME__: config.discordWebhookParameterName,
      __CONNECT_HOSTNAME__: publicIp,
    };
    for (const [token, value] of Object.entries(substitutions)) {
      bootScript = bootScript.split(token).join(value);
    }

    const embed = (tmpName: string, fileName: string, delimiter: string) =>
      `cat > /tmp/${tmpName} <<'${delimiter}'\n${readScript(fileName)}\n${delimiter}`;

    return [
      embed('idle-check.sh', 'idle-check.sh', 'MC_IDLE_CHECK_EOF'),
      embed('manual-stop.sh', 'manual-stop.sh', 'MC_MANUAL_STOP_EOF'),
      embed('ready-notify.sh', 'ready-notify.sh', 'MC_READY_NOTIFY_EOF'),
      bootScript,
    ];
  }
}
