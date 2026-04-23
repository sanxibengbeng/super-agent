---
name: cdk-infra
description: AWS CDK infrastructure operations for Super Agent - deploy, diff, synth, destroy stacks, manage CloudFormation resources. Use this skill whenever the user mentions: cdk, deploy, infrastructure, aws, cloudformation, stack, cdk diff, cdk deploy, cdk synth, cdk destroy, infra, provision, ec2, rds, cognito, s3, cloudfront, route53, or any variation of infrastructure/deployment operations. Also use when user wants to check deployment status, modify infrastructure config, or troubleshoot AWS resource issues.
---

# CDK Infra - AWS Infrastructure Operations

## Purpose

Manage AWS CDK infrastructure for Super Agent. The stack provisions EC2, RDS PostgreSQL, S3, Cognito (optional), CloudFront CDN (optional), and related networking resources.

## Stack Overview

**Location**: `infra/`

**Main Stack**: `SuperAgentStack` in `lib/super-agent-stack.ts`

### Core Resources (Always Created)
- VPC (default)
- Security Groups (EC2, RDS)
- EC2 Instance (m7g.medium ARM64, Graviton3)
- Elastic IP
- RDS PostgreSQL (Aurora Serverless v2)
- S3 Bucket (avatars, documents)
- IAM Role (EC2 instance profile)
- Redis (on EC2)
- Nginx reverse proxy
- systemd service

### Optional Resources
- **Cognito** (authMode=cognito): User Pool, App Client, Admin User
- **CDN** (enableCdn=true): S3 frontend bucket, CloudFront, ACM cert, Route53

## Common Operations

### View Pending Changes (Diff)

```bash
cd infra && npx cdk diff
```

Shows what will change without deploying.

### Deploy Stack

```bash
# Basic deploy
cd infra && npx cdk deploy

# With parameters
cd infra && npx cdk deploy \
  --parameters KeyPairName=my-keypair \
  --parameters AllowedCidr=10.0.0.0/8

# With context (enable CDN)
cd infra && npx cdk deploy \
  -c enableCdn=true \
  -c domainName=app.example.com \
  -c hostedZoneId=Z1234567890
```

### Synthesize CloudFormation Template

```bash
cd infra && npx cdk synth
```

Outputs CloudFormation YAML to `cdk.out/`.

### Destroy Stack

```bash
cd infra && npx cdk destroy
```

**Warning**: Destroys all resources. Data in RDS/S3 will be lost.

### Bootstrap (First Time Only)

```bash
cd infra && npx cdk bootstrap aws://ACCOUNT_ID/REGION
```

Required once per account/region before first deploy.

## Context Parameters

| Parameter | Values | Default | Description |
|-----------|--------|---------|-------------|
| `enableCdn` | true/false | false | Enable CloudFront CDN |
| `domainName` | string | - | Custom domain (required if CDN) |
| `hostedZoneId` | string | - | Route53 hosted zone ID (required if CDN) |
| `authMode` | cognito/local | local | Authentication mode |

### Example: Deploy with Cognito Auth

```bash
cd infra && npx cdk deploy -c authMode=cognito \
  --parameters AdminEmail=admin@company.com \
  --parameters CognitoDomainPrefix=myapp-auth
```

### Example: Deploy with CDN

```bash
cd infra && npx cdk deploy \
  -c enableCdn=true \
  -c domainName=app.mycompany.com \
  -c hostedZoneId=Z0123456789ABCDEFGHIJ
```

## Stack Parameters

| Parameter | Description |
|-----------|-------------|
| `KeyPairName` | EC2 key pair for SSH access |
| `AllowedCidr` | CIDR range for HTTP/HTTPS access (default: 0.0.0.0/0) |
| `AdminEmail` | Initial admin email (Cognito mode) |
| `CognitoDomainPrefix` | Cognito hosted UI domain prefix |

## Checking Deployment Status

### View Stack Outputs

```bash
cd infra && aws cloudformation describe-stacks \
  --stack-name SuperAgentStack \
  --query 'Stacks[0].Outputs' \
  --output table
```

### View Stack Events (Deployment Progress)

```bash
aws cloudformation describe-stack-events \
  --stack-name SuperAgentStack \
  --query 'StackEvents[0:10].[Timestamp,ResourceStatus,ResourceType,LogicalResourceId]' \
  --output table
```

### Check EC2 Instance Status

```bash
aws ec2 describe-instances \
  --filters "Name=tag:aws:cloudformation:stack-name,Values=SuperAgentStack" \
  --query 'Reservations[].Instances[].[InstanceId,State.Name,PublicIpAddress]' \
  --output table
```

## Troubleshooting

### Deploy Fails: "CDK bootstrap required"

```bash
cd infra && npx cdk bootstrap
```

### Deploy Fails: Missing Context

```
Error: enableCdn=true requires domainName and hostedZoneId
```

Provide all required context values:
```bash
npx cdk deploy -c enableCdn=true -c domainName=X -c hostedZoneId=Y
```

### Stack Rollback

Check CloudFormation console or:
```bash
aws cloudformation describe-stack-events \
  --stack-name SuperAgentStack \
  --query 'StackEvents[?ResourceStatus==`CREATE_FAILED` || ResourceStatus==`UPDATE_FAILED`]'
```

### Force Delete Stuck Stack

```bash
aws cloudformation delete-stack --stack-name SuperAgentStack
aws cloudformation wait stack-delete-complete --stack-name SuperAgentStack
```

## File Structure

```
infra/
├── bin/
│   └── app.ts              # CDK app entry point
├── lib/
│   └── super-agent-stack.ts # Main stack definition
├── lambda/
│   └── connectors/         # Lambda handlers for connectors
├── cdk.json                # CDK configuration
├── package.json
└── tsconfig.json
```

## Quick Reference

| Action | Command |
|--------|---------|
| View changes | `cd infra && npx cdk diff` |
| Deploy | `cd infra && npx cdk deploy` |
| Synth template | `cd infra && npx cdk synth` |
| Destroy | `cd infra && npx cdk destroy` |
| Bootstrap | `cd infra && npx cdk bootstrap` |
| List stacks | `cd infra && npx cdk list` |
