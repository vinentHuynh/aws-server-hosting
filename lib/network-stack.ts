import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { AppConfig } from './config';

export interface NetworkStackProps extends StackProps {
  readonly config: AppConfig;
}

export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;

    // Single public subnet, no NAT gateway, no private subnets: avoids NAT charges entirely.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    this.securityGroup = new ec2.SecurityGroup(this, 'ServerSecurityGroup', {
      vpc: this.vpc,
      description: 'Minecraft on-demand server',
      allowAllOutbound: true,
    });

    this.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(config.minecraftPort),
      'Minecraft client connections',
    );

    // RCON is intentionally never opened here; it is bound to localhost only on the instance.
    if (config.enableSsh) {
      if (!config.sshCidr) {
        throw new Error('sshCidr must be set when enableSsh=true.');
      }
      this.securityGroup.addIngressRule(
        ec2.Peer.ipv4(config.sshCidr),
        ec2.Port.tcp(22),
        'Restricted SSH access',
      );
    }

    Tags.of(this).add('Project', 'minecraft-server-ondemand');
    Tags.of(this).add('Environment', config.environment);
  }
}
