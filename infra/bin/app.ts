#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SuperAgentV2Stack } from '../lib/super-agent-v2-stack';

const app = new cdk.App();

new SuperAgentV2Stack(app, 'SuperAgentV2Stack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-west-2',
  },
  description: 'Super Agent Platform - full standalone deployment with hardened security',
});
