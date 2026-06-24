import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';

function synthNetworkStack(context: Record<string, unknown> = {}) {
  const app = new App({ context });
  const config = getConfig(app);
  const stack = new NetworkStack(app, 'TestNetwork', { config });
  return Template.fromStack(stack);
}

describe('NetworkStack', () => {
  test('creates no NAT gateways', () => {
    const template = synthNetworkStack();
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  test('allocates no Elastic IPs', () => {
    const template = synthNetworkStack();
    template.resourceCountIs('AWS::EC2::EIP', 0);
  });

  test('opens the Minecraft port to the world and nothing else', () => {
    const template = synthNetworkStack();
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: [
        {
          CidrIp: '0.0.0.0/0',
          FromPort: 25565,
          ToPort: 25565,
          IpProtocol: 'tcp',
        },
      ],
    });
  });

  test('opens SSH only when enableSsh=true with a CIDR', () => {
    const template = synthNetworkStack({ enableSsh: true, sshCidr: '203.0.113.5/32' });
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: [
        { FromPort: 25565 },
        { CidrIp: '203.0.113.5/32', FromPort: 22, ToPort: 22, IpProtocol: 'tcp' },
      ],
    });
  });

  test('never opens the RCON port', () => {
    const template = synthNetworkStack();
    const groups = template.findResources('AWS::EC2::SecurityGroup');
    for (const group of Object.values(groups)) {
      const ingress = (group as { Properties?: { SecurityGroupIngress?: unknown[] } }).Properties
        ?.SecurityGroupIngress ?? [];
      for (const rule of ingress as Array<{ FromPort?: number }>) {
        expect(rule.FromPort).not.toBe(25575);
      }
    }
  });
});
