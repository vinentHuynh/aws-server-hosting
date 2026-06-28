import * as path from 'path';
import { Duration, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { AppConfig } from './config';

export interface ControlStackProps extends StackProps {
  readonly config: AppConfig;
  readonly instanceId: string;
}

export class ControlStack extends Stack {
  public readonly wakeFunction: NodejsFunction;
  public readonly stopFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: ControlStackProps) {
    super(scope, id, props);
    const { config, instanceId } = props;

    const instanceArn = `arn:aws:ec2:${this.region}:${this.account}:instance/${instanceId}`;
    // AWS-owned public document: its real ARN has no account ID, unlike formatArn's default.
    const runShellScriptDocArn = this.formatArn({
      service: 'ssm',
      resource: 'document',
      resourceName: 'AWS-RunShellScript',
      account: '',
    });

    this.wakeFunction = new NodejsFunction(this, 'WakeFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'wake', 'index.ts'),
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      environment: { INSTANCE_ID: instanceId },
      bundling: { minify: true },
    });
    this.wakeFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DescribeAnyInstance',
        actions: ['ec2:DescribeInstances'],
        resources: ['*'],
      }),
    );
    this.wakeFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'StartTheServerInstance',
        actions: ['ec2:StartInstances'],
        resources: [instanceArn],
      }),
    );

    this.stopFunction = new NodejsFunction(this, 'StopFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'stop', 'index.ts'),
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.minutes(3),
      environment: { INSTANCE_ID: instanceId },
      bundling: { minify: true },
    });
    this.stopFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DescribeAnyInstance',
        actions: ['ec2:DescribeInstances'],
        resources: ['*'],
      }),
    );
    this.stopFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'StopTheServerInstance',
        actions: ['ec2:StopInstances'],
        resources: [instanceArn],
      }),
    );
    this.stopFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'RunGracefulShutdownScript',
        actions: ['ssm:SendCommand'],
        resources: [instanceArn, runShellScriptDocArn],
      }),
    );
    this.stopFunction.addToRolePolicy(
      new iam.PolicyStatement({
        // GetCommandInvocation does not support resource-level scoping.
        sid: 'ReadCommandInvocationStatus',
        actions: ['ssm:GetCommandInvocation'],
        resources: ['*'],
      }),
    );

    Tags.of(this).add('Project', 'minecraft-server-ondemand');
    Tags.of(this).add('Environment', config.environment);
  }
}
