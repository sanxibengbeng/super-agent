#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SuperAgentStack } from '../lib/super-agent-stack';

const app = new cdk.App();

// Context values (pass via -c or cdk.json context):
//   env:          Environment name — drives all resource naming (default: dev)
//   enableCdn:    "true" to deploy CloudFront + S3 frontend + ACM + Route53
//   domainName:   Custom domain (required when enableCdn=true)
//   hostedZoneId: Route53 hosted zone ID (required when enableCdn=true)
//   authMode:     "cognito" | "local" (default: local)

const envName = app.node.tryGetContext('env') || 'dev';
const region = app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION || 'ap-southeast-1';
const enableCdn = app.node.tryGetContext('enableCdn') === 'true';
const enableAgentCore = app.node.tryGetContext('enableAgentCore') !== 'false';
const stackName = `SuperAgent-${envName}`;

new SuperAgentStack(app, stackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  description: `Super Agent Platform (${envName})`,
  envName,
  enableCdn,
  enableAgentCore,
});
