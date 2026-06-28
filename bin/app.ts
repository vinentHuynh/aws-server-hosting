#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { getConfig } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { ServerStack } from '../lib/server-stack';
import { ControlStack } from '../lib/control-stack';
import { DiscordStack } from '../lib/discord-stack';

const app = new cdk.App();
const config = getConfig(app);

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const network = new NetworkStack(app, `McOndemandNetwork-${config.environment}`, {
  env,
  config,
});

const server = new ServerStack(app, `McOndemandServer-${config.environment}`, {
  env,
  config,
  vpc: network.vpc,
  securityGroup: network.securityGroup,
});

if (config.discordEnabled) {
  const control = new ControlStack(app, `McOndemandControl-${config.environment}`, {
    env,
    config,
    instanceId: server.instance.instanceId,
  });

  new DiscordStack(app, `McOndemandDiscord-${config.environment}`, {
    env,
    config,
    instanceId: server.instance.instanceId,
    wakeFunctionArn: control.wakeFunction.functionArn,
    wakeFunctionName: control.wakeFunction.functionName,
    stopFunctionArn: control.stopFunction.functionArn,
    stopFunctionName: control.stopFunction.functionName,
  });
}
