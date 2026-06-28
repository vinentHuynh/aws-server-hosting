import * as path from 'path';
import { ArnFormat, CfnOutput, Duration, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { AppConfig } from './config';

export interface DiscordStackProps extends StackProps {
  readonly config: AppConfig;
  readonly instanceId: string;
  readonly connectHostname?: string;
  readonly wakeFunctionArn: string;
  readonly wakeFunctionName: string;
  readonly stopFunctionArn: string;
  readonly stopFunctionName: string;
}

export class DiscordStack extends Stack {
  constructor(scope: Construct, id: string, props: DiscordStackProps) {
    super(scope, id, props);
    const {
      config,
      instanceId,
      connectHostname,
      wakeFunctionArn,
      wakeFunctionName,
      stopFunctionArn,
      stopFunctionName,
    } = props;

    if (!config.discordPublicKey) {
      throw new Error('discordPublicKey is required to deploy DiscordStack.');
    }

    const instanceArn = `arn:aws:ec2:${this.region}:${this.account}:instance/${instanceId}`;
    // AWS-owned public document: its real ARN has no account ID, unlike formatArn's default.
    const runShellScriptDocArn = this.formatArn({
      service: 'ssm',
      resource: 'document',
      resourceName: 'AWS-RunShellScript',
      account: '',
    });

    // Given an explicit, fixed name so its own ARN can be built as a plain
    // string below (see selfArn) instead of a token referencing the function's
    // own (CloudFormation-generated) attributes -- self-granting lambda:InvokeFunction
    // via such a token creates a circular dependency between the function and its policy.
    const discordFunctionName = `mc-discord-interactions-${config.environment}`;

    const discordFunction = new NodejsFunction(this, 'DiscordInteractionFunction', {
      functionName: discordFunctionName,
      entry: path.join(__dirname, '..', 'lambda', 'discord', 'index.ts'),
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.seconds(10),
      // Discord requires the initial ack within 3 seconds; more memory means
      // more CPU, which cuts cold-start time enough to reliably make that window.
      memorySize: 512,
      environment: {
        // The public key is not sensitive (it's used to verify, not sign), so a
        // plain Lambda environment variable is fine here — no SSM/Secrets needed.
        DISCORD_PUBLIC_KEY: config.discordPublicKey,
        WAKE_FUNCTION_NAME: wakeFunctionName,
        STOP_FUNCTION_NAME: stopFunctionName,
        INSTANCE_ID: instanceId,
        MAX_PLAYERS: String(config.maxPlayers),
        CONNECT_HOSTNAME: connectHostname ?? '',
      },
      bundling: { minify: true },
    });

    const selfArn = this.formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: discordFunctionName,
      // Lambda ARNs are "function:name", not the default "function/name".
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    discordFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'InvokeControlLambdasAndSelf',
        actions: ['lambda:InvokeFunction'],
        resources: [wakeFunctionArn, stopFunctionArn, selfArn],
      }),
    );
    discordFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DescribeAnyInstance',
        actions: ['ec2:DescribeInstances'],
        resources: ['*'],
      }),
    );
    discordFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'QueryPlayerCount',
        actions: ['ssm:SendCommand'],
        resources: [instanceArn, runShellScriptDocArn],
      }),
    );
    discordFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadCommandInvocationStatus',
        actions: ['ssm:GetCommandInvocation'],
        resources: ['*'],
      }),
    );
    discordFunction.addToRolePolicy(
      new iam.PolicyStatement({
        // Cost Explorer actions do not support resource-level scoping.
        sid: 'ReadCostAndForecast',
        actions: ['ce:GetCostAndUsage', 'ce:GetCostForecast'],
        resources: ['*'],
      }),
    );

    const httpApi = new apigwv2.HttpApi(this, 'DiscordInteractionsApi', {
      description: 'Discord interactions endpoint for the Minecraft on-demand bot',
    });
    httpApi.addRoutes({
      path: '/discord/interactions',
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration('DiscordIntegration', discordFunction),
    });

    new CfnOutput(this, 'InteractionsEndpointUrl', {
      value: `${httpApi.apiEndpoint}/discord/interactions`,
      description: 'Paste this into the Discord application\'s Interactions Endpoint URL field',
    });

    Tags.of(this).add('Project', 'minecraft-server-ondemand');
    Tags.of(this).add('Environment', config.environment);
  }
}
