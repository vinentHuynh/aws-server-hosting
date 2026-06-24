#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { getConfig } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { ServerStack } from '../lib/server-stack';

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

new ServerStack(app, `McOndemandServer-${config.environment}`, {
  env,
  config,
  vpc: network.vpc,
  securityGroup: network.securityGroup,
});
