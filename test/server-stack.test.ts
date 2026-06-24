import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { ServerStack } from '../lib/server-stack';

function synthServerStack(context: Record<string, unknown> = {}) {
  const app = new App({ context });
  const config = getConfig(app);
  const network = new NetworkStack(app, 'TestNetwork', { config });
  const server = new ServerStack(app, 'TestServer', {
    config,
    vpc: network.vpc,
    securityGroup: network.securityGroup,
  });
  return Template.fromStack(server);
}

describe('ServerStack', () => {
  test('uses the configured instance type', () => {
    const template = synthServerStack({ instanceType: 't3.medium' });
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't3.medium',
    });
  });

  test('requires IMDSv2', () => {
    const template = synthServerStack();
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        MetadataOptions: { HttpTokens: 'required' },
      }),
    });
  });

  test('sizes the root volume from config', () => {
    const template = synthServerStack({ rootVolumeSizeGiB: 8 });
    template.hasResourceProperties('AWS::EC2::Instance', {
      BlockDeviceMappings: [
        Match.objectLike({
          DeviceName: '/dev/xvda',
          Ebs: Match.objectLike({ VolumeSize: 8, VolumeType: 'gp3' }),
        }),
      ],
    });
  });

  test('creates an encrypted, retained world volume sized from config', () => {
    const template = synthServerStack({ worldVolumeSizeGiB: 10 });
    template.hasResource('AWS::EC2::Volume', {
      Properties: Match.objectLike({ Size: 10, Encrypted: true }),
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('scopes ec2:StopInstances to the mc-server tag, not a wildcard', () => {
    const template = synthServerStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ec2:StopInstances',
            Condition: { StringEquals: { 'ec2:ResourceTag/Role': 'mc-server' } },
          }),
        ]),
      }),
    });
  });

  test('grants read access only to the configured RCON parameter', () => {
    const template = synthServerStack({ rconParameterName: '/test/rcon-password' });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'ssm:GetParameter' }),
        ]),
      }),
    });
    // Resource is an unresolved Fn::Join (account/region tokens) in this test's
    // env-agnostic stack, so check the parameter path landed in the ARN by substring.
    expect(JSON.stringify(template.toJSON())).toContain('parameter/test/rcon-password');
  });
});
