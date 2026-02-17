#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SuperAgentStack } from '../lib/super-agent-stack';

const app = new cdk.App();

new SuperAgentStack(app, 'SuperAgentStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-west-2',
  },
  description: 'Super Agent Platform — single EC2 deployment with Aurora PostgreSQL, Redis, and Node.js',
});
