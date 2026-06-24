import * as fs from 'fs';
import * as path from 'path';
import { CfnOutput, RemovalPolicy, Size, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
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
        sid: 'ReadRconPassword',
        actions: ['ssm:GetParameter'],
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: config.rconParameterName.replace(/^\//, ''),
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

    this.instance.userData.addCommands(...this.renderUserData(config, worldVolume.volumeId));

    new CfnOutput(this, 'InstanceId', { value: this.instance.instanceId });
    new CfnOutput(this, 'HowToFindPublicIp', {
      value: `aws ec2 describe-instances --instance-ids ${this.instance.instanceId} --query "Reservations[0].Instances[0].PublicIpAddress" --output text --profile mc-deployer --region ${this.region}`,
    });
  }

  private renderUserData(config: AppConfig, worldVolumeId: string): string[] {
    const idleCheckScript = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'idle-check.sh'),
      'utf8',
    );

    let bootScript = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'user-data.sh'),
      'utf8',
    );
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
    };
    for (const [token, value] of Object.entries(substitutions)) {
      bootScript = bootScript.split(token).join(value);
    }

    const writeIdleCheck = `cat > /tmp/idle-check.sh <<'MC_IDLE_CHECK_EOF'\n${idleCheckScript}\nMC_IDLE_CHECK_EOF`;

    return [writeIdleCheck, bootScript];
  }
}
