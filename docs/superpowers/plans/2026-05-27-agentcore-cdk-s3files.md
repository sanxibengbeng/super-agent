# AgentCore CDK + S3 Files + ECS Fargate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the EC2-based deployment with ECS Fargate + CDK-managed AgentCore Runtime + S3 Files mounts, eliminating manual workspace S3 sync.

**Architecture:** New CDK stack with 3-tier VPC (public/private/isolated), ECS Fargate cluster (3 services by PROCESS_ROLE), CloudFront VPC Origin → internal ALB, CfnRuntime with S3 Files filesystem mount, and per-scope dynamic Access Points for multi-tenant isolation.

**Tech Stack:** AWS CDK v2.257+, ECS Fargate, ALB, CloudFront VPC Origin, RDS Aurora PostgreSQL, ElastiCache Redis, S3 Files (CfnFileSystem + CfnAccessPoint), BedrockAgentCore (CfnRuntime), WAF v2, Secrets Manager.

---

## File Structure

### CDK Infrastructure (`infra/`)

| File | Responsibility |
|------|---------------|
| `infra/lib/super-agent-stack.ts` | Complete rewrite — new production stack |
| `infra/lib/constructs/vpc.ts` | VPC construct (3-tier subnets, NAT, endpoints) |
| `infra/lib/constructs/ecs-cluster.ts` | ECS cluster + 3 Fargate services + ALB |
| `infra/lib/constructs/data-layer.ts` | RDS Aurora + ElastiCache Redis |
| `infra/lib/constructs/agentcore.ts` | CfnRuntime + S3 Files FileSystem + IAM |
| `infra/lib/constructs/cdn.ts` | CloudFront + VPC Origin + WAF |
| `infra/lib/constructs/secrets.ts` | Secrets Manager resources |

### Backend Changes

| File | Responsibility |
|------|---------------|
| `backend/src/services/s3files.service.ts` | Create/cache/delete S3 Files Access Points per scope |
| `backend/src/services/agent-runtime-agentcore.ts` | Simplify: remove upload/sync, add AP ARN to invoke |
| `backend/src/config/index.ts` | Add S3 Files config vars |
| `backend/prisma/migrations/XXXX_add_workspace_ap_arn/migration.sql` | Add column to business_scopes |
| `backend/prisma/schema.prisma` | Add `workspace_access_point_arn` field |

### Container Changes

| File | Responsibility |
|------|---------------|
| `agentcore/src/index.ts` | Remove S3 restore/watcher, use /mnt/ws directly |
| `agentcore/src/agent-runner.ts` | Remove S3 sync hooks, use /mnt/ws as cwd |
| `agentcore/src/workspace-sync.ts` | DELETE entirely |
| `agentcore/src/file-watcher.ts` | DELETE entirely |
| `agentcore/Dockerfile` | Update paths, remove @aws-sdk/client-s3 |
| `agentcore/package.json` | Remove @aws-sdk/client-s3 dependency |

---

## Task 1: Upgrade CDK to v2.257+

**Files:**
- Modify: `infra/package.json`
- Modify: `infra/package-lock.json` (auto-generated)

- [ ] **Step 1: Update CDK version in package.json**

```json
{
  "dependencies": {
    "aws-cdk-lib": "^2.257.0",
    "constructs": "^10.4.2"
  },
  "devDependencies": {
    "@types/node": "^25.2.3",
    "aws-cdk": "^2.257.0",
    "source-map-support": "^0.5.21",
    "ts-node": "^10.9.2",
    "typescript": "~5.9.3"
  }
}
```

- [ ] **Step 2: Install updated dependencies**

Run: `cd /home/ubuntu/super-agent/infra && npm install`
Expected: Clean install, `node_modules/aws-cdk-lib/aws-bedrockagentcore/` and `node_modules/aws-cdk-lib/aws-s3files/` directories exist.

- [ ] **Step 3: Verify new modules are available**

Run: `ls infra/node_modules/aws-cdk-lib/aws-bedrockagentcore/lib/ && ls infra/node_modules/aws-cdk-lib/aws-s3files/lib/`
Expected: Both directories contain `.d.ts` and `.js` files including generated constructs.

- [ ] **Step 4: Commit**

```bash
git add infra/package.json infra/package-lock.json
git commit -m "chore(infra): upgrade CDK to v2.257 for AgentCore + S3 Files support"
```

---

## Task 2: VPC Construct

**Files:**
- Create: `infra/lib/constructs/vpc.ts`

- [ ] **Step 1: Create constructs directory**

Run: `mkdir -p /home/ubuntu/super-agent/infra/lib/constructs`

- [ ] **Step 2: Write VPC construct**

```typescript
// infra/lib/constructs/vpc.ts
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface SuperAgentVpcProps {
  maxAzs?: number;
}

export class SuperAgentVpc extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly ecsSecurityGroup: ec2.SecurityGroup;
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly dbSecurityGroup: ec2.SecurityGroup;
  public readonly redisSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props?: SuperAgentVpcProps) {
    super(scope, id);

    const maxAzs = props?.maxAzs ?? 2;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs,
      natGateways: maxAzs,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    // VPC Endpoints
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    this.vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
    });
    this.vpc.addInterfaceEndpoint('EcrDkrEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });
    this.vpc.addInterfaceEndpoint('LogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    });
    this.vpc.addInterfaceEndpoint('SecretsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    });

    // Security Groups
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'ALB - accepts traffic from CloudFront only',
      allowAllOutbound: true,
    });

    this.ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc: this.vpc,
      description: 'ECS Fargate tasks',
      allowAllOutbound: true,
    });
    this.ecsSecurityGroup.addIngressRule(
      this.albSecurityGroup, ec2.Port.tcp(3000), 'From ALB',
    );

    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSg', {
      vpc: this.vpc,
      description: 'RDS PostgreSQL',
      allowAllOutbound: false,
    });
    this.dbSecurityGroup.addIngressRule(
      this.ecsSecurityGroup, ec2.Port.tcp(5432), 'PostgreSQL from ECS',
    );

    this.redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc: this.vpc,
      description: 'ElastiCache Redis',
      allowAllOutbound: false,
    });
    this.redisSecurityGroup.addIngressRule(
      this.ecsSecurityGroup, ec2.Port.tcp(6379), 'Redis from ECS',
    );
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /home/ubuntu/super-agent/infra && npx tsc --noEmit --strict infra/lib/constructs/vpc.ts 2>&1 | head -20`
Expected: No errors (or only errors about missing imports from main stack which doesn't reference this yet).

- [ ] **Step 4: Commit**

```bash
git add infra/lib/constructs/vpc.ts
git commit -m "feat(infra): add VPC construct with 3-tier subnets and endpoints"
```

---

## Task 3: Data Layer Construct (RDS Aurora + Redis)

**Files:**
- Create: `infra/lib/constructs/data-layer.ts`

- [ ] **Step 1: Write data layer construct**

```typescript
// infra/lib/constructs/data-layer.ts
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface DataLayerProps {
  vpc: ec2.IVpc;
  dbSecurityGroup: ec2.ISecurityGroup;
  redisSecurityGroup: ec2.ISecurityGroup;
}

export class DataLayer extends Construct {
  public readonly dbCluster: rds.DatabaseCluster;
  public readonly dbSecret: secretsmanager.ISecret;
  public readonly redisEndpoint: string;
  public readonly redisPort: string;

  constructor(scope: Construct, id: string, props: DataLayerProps) {
    super(scope, id);

    // Aurora PostgreSQL 16 (Multi-AZ via Aurora replication)
    this.dbCluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
      }),
      writer: rds.ClusterInstance.provisioned('Writer', {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      }),
      readers: [
        rds.ClusterInstance.provisioned('Reader', {
          instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
        }),
      ],
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.dbSecurityGroup],
      defaultDatabaseName: 'super_agent',
      credentials: rds.Credentials.fromGeneratedSecret('superagent', {
        secretName: 'super-agent/db-credentials',
      }),
      storageEncrypted: true,
      backup: { retention: cdk.Duration.days(7) },
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    this.dbSecret = this.dbCluster.secret!;

    // ElastiCache Redis 7.1 (Multi-AZ replication group)
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Redis subnets (isolated)',
      subnetIds: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });

    const redisReplicationGroup = new elasticache.CfnReplicationGroup(this, 'RedisReplicationGroup', {
      replicationGroupDescription: 'Super Agent Redis',
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: 'cache.t4g.small',
      numNodeGroups: 1,
      replicasPerNodeGroup: 1,
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      cacheSubnetGroupName: redisSubnetGroup.ref,
      securityGroupIds: [props.redisSecurityGroup.securityGroupId],
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true,
      port: 6379,
    });
    redisReplicationGroup.addDependency(redisSubnetGroup);

    this.redisEndpoint = redisReplicationGroup.attrPrimaryEndPointAddress;
    this.redisPort = redisReplicationGroup.attrPrimaryEndPointPort;
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/ubuntu/super-agent/infra && npx tsc --noEmit`
Expected: No type errors from data-layer.ts

- [ ] **Step 3: Commit**

```bash
git add infra/lib/constructs/data-layer.ts
git commit -m "feat(infra): add data layer construct with Aurora PostgreSQL + Redis Multi-AZ"
```

---

## Task 4: Secrets Manager Construct

**Files:**
- Create: `infra/lib/constructs/secrets.ts`

- [ ] **Step 1: Write secrets construct**

```typescript
// infra/lib/constructs/secrets.ts
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface SecretsProps {
  dbSecretArn: string;
}

export class Secrets extends Construct {
  public readonly appSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, _props: SecretsProps) {
    super(scope, id);

    this.appSecret = new secretsmanager.Secret(this, 'AppSecret', {
      secretName: 'super-agent/app-config',
      description: 'Super Agent application secrets (JWT, API keys)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          JWT_SECRET: '',
          ANTHROPIC_API_KEY: '',
          LANGFUSE_SECRET_KEY: '',
          LANGFUSE_PUBLIC_KEY: '',
        }),
        generateStringKey: 'JWT_SECRET',
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add infra/lib/constructs/secrets.ts
git commit -m "feat(infra): add Secrets Manager construct for app configuration"
```

---

## Task 5: AgentCore + S3 Files Construct

**Files:**
- Create: `infra/lib/constructs/agentcore.ts`

- [ ] **Step 1: Write AgentCore construct with S3 Files**

```typescript
// infra/lib/constructs/agentcore.ts
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as s3files from 'aws-cdk-lib/aws-s3files';
import { Construct } from 'constructs';

export interface AgentCoreProps {
  workspaceBucket: s3.IBucket;
  containerUri: string;
  region: string;
  account: string;
}

export class AgentCoreConstruct extends Construct {
  public readonly runtime: bedrockagentcore.CfnRuntime;
  public readonly executionRole: iam.Role;
  public readonly fileSystem: s3files.CfnFileSystem;
  public readonly s3FilesRole: iam.Role;

  constructor(scope: Construct, id: string, props: AgentCoreProps) {
    super(scope, id);

    // S3 Files Role — allows S3 Files service to read/write the workspace bucket
    this.s3FilesRole = new iam.Role(this, 'S3FilesRole', {
      assumedBy: new iam.ServicePrincipal('s3files.amazonaws.com'),
      description: 'Allows S3 Files to access workspace bucket',
    });
    props.workspaceBucket.grantReadWrite(this.s3FilesRole);
    this.s3FilesRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [props.workspaceBucket.bucketArn],
    }));

    // S3 Files FileSystem
    this.fileSystem = new s3files.CfnFileSystem(this, 'WorkspaceFileSystem', {
      bucket: props.workspaceBucket.bucketName,
      roleArn: this.s3FilesRole.roleArn,
    });

    // AgentCore Execution Role
    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'AgentCore runtime execution role',
    });

    // Bedrock model invocation
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:${props.region}::foundation-model/anthropic.*`,
        `arn:aws:bedrock:${props.region}::foundation-model/us.anthropic.*`,
      ],
    }));

    // S3 workspace access (for S3 Files mount)
    props.workspaceBucket.grantReadWrite(this.executionRole);

    // CloudWatch Logs
    this.executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${props.region}:${props.account}:log-group:/aws/bedrock-agentcore/*`],
    }));

    // CfnRuntime
    this.runtime = new bedrockagentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: 'super-agent-runtime',
      roleArn: this.executionRole.roleArn,
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: props.containerUri,
        },
      },
      networkConfiguration: {
        networkMode: 'PUBLIC',
      },
      filesystemConfigurations: [
        {
          sessionStorage: { mountPath: '/mnt/session' },
        },
      ],
      environmentVariables: {
        WORKSPACE_DIR: '/mnt/ws',
        HOME: '/mnt/session',
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_MODEL: 'us.anthropic.claude-sonnet-4-6',
      },
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: 900,
        maxLifetime: 28800,
      },
    });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/ubuntu/super-agent/infra && npx tsc --noEmit`
Expected: No type errors. If CfnRuntime prop names differ from expectations, fix based on actual `.d.ts` definitions.

- [ ] **Step 3: Commit**

```bash
git add infra/lib/constructs/agentcore.ts
git commit -m "feat(infra): add AgentCore construct with CfnRuntime + S3 Files FileSystem"
```

---

## Task 6: ECS Cluster Construct

**Files:**
- Create: `infra/lib/constructs/ecs-cluster.ts`

- [ ] **Step 1: Write ECS cluster construct**

```typescript
// infra/lib/constructs/ecs-cluster.ts
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface EcsClusterProps {
  vpc: ec2.IVpc;
  ecsSecurityGroup: ec2.ISecurityGroup;
  albSecurityGroup: ec2.ISecurityGroup;
  dbSecret: secretsmanager.ISecret;
  appSecret: secretsmanager.ISecret;
  redisEndpoint: string;
  redisPort: string;
  workspaceBucketName: string;
  assetsBucketName: string;
  agentCoreRuntimeArn: string;
  s3FilesFileSystemId: string;
  region: string;
  account: string;
}

export class EcsClusterConstruct extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly apiService: ecs.FargateService;
  public readonly workerService: ecs.FargateService;
  public readonly gatewayService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: EcsClusterProps) {
    super(scope, id);

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: 'super-agent',
      containerInsights: true,
    });

    // Internal ALB
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: false,
      securityGroup: props.albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const listener = this.alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        messageBody: 'Not Found',
      }),
    });

    // Shared log group
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/super-agent/ecs',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Shared execution role
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    props.dbSecret.grantRead(executionRole);
    props.appSecret.grantRead(executionRole);

    // --- API Service ---
    const apiTaskRole = new iam.Role(this, 'ApiTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    apiTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
      resources: [
        `arn:aws:s3:::${props.workspaceBucketName}/*`,
        `arn:aws:s3:::${props.assetsBucketName}/*`,
      ],
    }));

    const apiTaskDef = new ecs.FargateTaskDefinition(this, 'ApiTaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole,
      taskRole: apiTaskRole,
    });

    const sharedEnv = {
      NODE_ENV: 'production',
      REDIS_HOST: props.redisEndpoint,
      REDIS_PORT: props.redisPort,
      REDIS_TLS: 'true',
      AWS_REGION: props.region,
      S3_BUCKET_NAME: props.assetsBucketName,
      AGENTCORE_WORKSPACE_S3_BUCKET: props.workspaceBucketName,
      AGENTCORE_RUNTIME_ARN: props.agentCoreRuntimeArn,
      AGENTCORE_S3FILES_FILESYSTEM_ID: props.s3FilesFileSystemId,
    };

    const sharedSecrets = {
      DATABASE_URL: ecs.Secret.fromSecretsManager(props.dbSecret, 'connectionString'),
      JWT_SECRET: ecs.Secret.fromSecretsManager(props.appSecret, 'JWT_SECRET'),
    };

    apiTaskDef.addContainer('api', {
      image: ecs.ContainerImage.fromRegistry(`${props.account}.dkr.ecr.${props.region}.amazonaws.com/super-agent-backend:latest`),
      environment: { ...sharedEnv, PROCESS_ROLE: 'api', PORT: '3000' },
      secrets: sharedSecrets,
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'api' }),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
      },
    });

    this.apiService = new ecs.FargateService(this, 'ApiService', {
      cluster: this.cluster,
      taskDefinition: apiTaskDef,
      desiredCount: 2,
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
    });

    const apiTargetGroup = listener.addTargets('ApiTarget', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.apiService],
      healthCheck: { path: '/health', interval: cdk.Duration.seconds(30) },
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/*', '/health', '/v1/*']),
      ],
      priority: 10,
    });

    // API auto-scaling
    const apiScaling = this.apiService.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 6 });
    apiScaling.scaleOnCpuUtilization('CpuScaling', { targetUtilizationPercent: 70 });

    // --- Worker Service ---
    const workerTaskRole = new iam.Role(this, 'WorkerTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    workerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:InvokeAgentRuntime',
        'bedrock-agentcore:CreateAgentRuntimeSession',
        'bedrock-agentcore:GetAgentRuntimeSession',
        'bedrock-agentcore:DeleteAgentRuntimeSession',
      ],
      resources: [props.agentCoreRuntimeArn],
    }));
    workerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3files:CreateAccessPoint', 's3files:DescribeAccessPoint', 's3files:DeleteAccessPoint'],
      resources: [`arn:aws:s3files:${props.region}:${props.account}:filesystem/${props.s3FilesFileSystemId}/*`],
    }));
    workerTaskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:*'],
      resources: [
        `arn:aws:s3:::${props.workspaceBucketName}`,
        `arn:aws:s3:::${props.workspaceBucketName}/*`,
      ],
    }));
    props.appSecret.grantRead(workerTaskRole);

    const workerTaskDef = new ecs.FargateTaskDefinition(this, 'WorkerTaskDef', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      executionRole,
      taskRole: workerTaskRole,
    });

    workerTaskDef.addContainer('worker', {
      image: ecs.ContainerImage.fromRegistry(`${props.account}.dkr.ecr.${props.region}.amazonaws.com/super-agent-backend:latest`),
      environment: { ...sharedEnv, PROCESS_ROLE: 'worker', PORT: '3000' },
      secrets: sharedSecrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'worker' }),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
      },
    });

    this.workerService = new ecs.FargateService(this, 'WorkerService', {
      cluster: this.cluster,
      taskDefinition: workerTaskDef,
      desiredCount: 2,
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
    });

    const workerScaling = this.workerService.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 4 });
    workerScaling.scaleOnCpuUtilization('CpuScaling', { targetUtilizationPercent: 70 });

    // --- Gateway Service ---
    const gatewayTaskRole = new iam.Role(this, 'GatewayTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const gatewayTaskDef = new ecs.FargateTaskDefinition(this, 'GatewayTaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole,
      taskRole: gatewayTaskRole,
    });

    gatewayTaskDef.addContainer('gateway', {
      image: ecs.ContainerImage.fromRegistry(`${props.account}.dkr.ecr.${props.region}.amazonaws.com/super-agent-backend:latest`),
      environment: { ...sharedEnv, PROCESS_ROLE: 'gateway', PORT: '3000' },
      secrets: sharedSecrets,
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'gateway' }),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
      },
    });

    this.gatewayService = new ecs.FargateService(this, 'GatewayService', {
      cluster: this.cluster,
      taskDefinition: gatewayTaskDef,
      desiredCount: 2,
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
    });

    listener.addTargets('GatewayTarget', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.gatewayService],
      healthCheck: { path: '/health', interval: cdk.Duration.seconds(30) },
      conditions: [elbv2.ListenerCondition.pathPatterns(['/ws/*'])],
      priority: 5,
      stickinessCookieDuration: cdk.Duration.hours(1),
    });

    // Gateway ALB idle timeout for WebSocket
    this.alb.setAttribute('idle_timeout.timeout_seconds', '3600');

    const gatewayScaling = this.gatewayService.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 4 });
    gatewayScaling.scaleOnCpuUtilization('CpuScaling', { targetUtilizationPercent: 70 });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/ubuntu/super-agent/infra && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add infra/lib/constructs/ecs-cluster.ts
git commit -m "feat(infra): add ECS Fargate construct with api/worker/gateway services"
```

---

## Task 7: CDN Construct (CloudFront + VPC Origin + WAF)

**Files:**
- Create: `infra/lib/constructs/cdn.ts`

- [ ] **Step 1: Write CDN construct**

```typescript
// infra/lib/constructs/cdn.ts
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface CdnProps {
  alb: elbv2.IApplicationLoadBalancer;
  frontendBucket?: s3.IBucket;
}

export class CdnConstruct extends Construct {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CdnProps) {
    super(scope, id);

    // WAF Web ACL
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'SuperAgentWaf',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'RateLimit',
          priority: 1,
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimit',
            sampledRequestsEnabled: true,
          },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
          },
        },
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRules',
            sampledRequestsEnabled: true,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
        },
      ],
    });

    // CloudFront VPC Origin → internal ALB
    const vpcOrigin = new origins.HttpOrigin(props.alb.loadBalancerDnsName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: vpcOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
      webAclId: webAcl.attrArn,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      errorResponses: [
        { httpStatus: 502, ttl: cdk.Duration.seconds(5) },
        { httpStatus: 503, ttl: cdk.Duration.seconds(5) },
      ],
    });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add infra/lib/constructs/cdn.ts
git commit -m "feat(infra): add CloudFront CDN construct with VPC Origin and WAF"
```

---

## Task 8: Rewrite Main Stack

**Files:**
- Modify: `infra/lib/super-agent-stack.ts`
- Modify: `infra/bin/app.ts`

- [ ] **Step 1: Rewrite super-agent-stack.ts**

```typescript
// infra/lib/super-agent-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
import { SuperAgentVpc } from './constructs/vpc';
import { DataLayer } from './constructs/data-layer';
import { Secrets } from './constructs/secrets';
import { AgentCoreConstruct } from './constructs/agentcore';
import { EcsClusterConstruct } from './constructs/ecs-cluster';
import { CdnConstruct } from './constructs/cdn';

export class SuperAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =========================================================================
    // VPC
    // =========================================================================
    const { vpc, ecsSecurityGroup, albSecurityGroup, dbSecurityGroup, redisSecurityGroup } =
      new SuperAgentVpc(this, 'Network');

    // =========================================================================
    // S3 Buckets
    // =========================================================================
    const workspaceBucket = new s3.Bucket(this, 'WorkspaceBucket', {
      bucketName: `super-agent-workspace-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      lifecycleRules: [
        {
          noncurrentVersionTransition: [{
            storageClass: s3.StorageClass.INFREQUENT_ACCESS,
            transitionAfter: cdk.Duration.days(30),
          }],
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
      ],
    });

    const assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      bucketName: `super-agent-assets-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
    });

    // =========================================================================
    // ECR Repositories
    // =========================================================================
    const backendRepo = new ecr.Repository(this, 'BackendRepo', {
      repositoryName: 'super-agent-backend',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    const agentcoreRepo = new ecr.Repository(this, 'AgentCoreRepo', {
      repositoryName: 'super-agent-agentcore',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    // =========================================================================
    // Data Layer
    // =========================================================================
    const dataLayer = new DataLayer(this, 'Data', {
      vpc: vpc,
      dbSecurityGroup,
      redisSecurityGroup,
    });

    // =========================================================================
    // Secrets
    // =========================================================================
    const secrets = new Secrets(this, 'Secrets', {
      dbSecretArn: dataLayer.dbSecret.secretArn,
    });

    // =========================================================================
    // AgentCore + S3 Files
    // =========================================================================
    const agentCore = new AgentCoreConstruct(this, 'AgentCore', {
      workspaceBucket,
      containerUri: `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${agentcoreRepo.repositoryName}:latest`,
      region: this.region,
      account: this.account,
    });

    // =========================================================================
    // ECS Cluster
    // =========================================================================
    const ecsCluster = new EcsClusterConstruct(this, 'Ecs', {
      vpc,
      ecsSecurityGroup,
      albSecurityGroup,
      dbSecret: dataLayer.dbSecret,
      appSecret: secrets.appSecret,
      redisEndpoint: dataLayer.redisEndpoint,
      redisPort: dataLayer.redisPort,
      workspaceBucketName: workspaceBucket.bucketName,
      assetsBucketName: assetsBucket.bucketName,
      agentCoreRuntimeArn: agentCore.runtime.attrAgentRuntimeArn,
      s3FilesFileSystemId: agentCore.fileSystem.ref,
      region: this.region,
      account: this.account,
    });

    // =========================================================================
    // CloudFront CDN
    // =========================================================================
    const cdn = new CdnConstruct(this, 'Cdn', {
      alb: ecsCluster.alb,
    });

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'CloudFrontDomain', { value: cdn.distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'AlbDnsName', { value: ecsCluster.alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'DbClusterEndpoint', { value: dataLayer.dbCluster.clusterEndpoint.hostname });
    new cdk.CfnOutput(this, 'DbSecretArn', { value: dataLayer.dbSecret.secretArn });
    new cdk.CfnOutput(this, 'RedisEndpoint', { value: dataLayer.redisEndpoint });
    new cdk.CfnOutput(this, 'WorkspaceBucketName', { value: workspaceBucket.bucketName });
    new cdk.CfnOutput(this, 'AssetsBucketName', { value: assetsBucket.bucketName });
    new cdk.CfnOutput(this, 'AgentCoreRuntimeArn', { value: agentCore.runtime.attrAgentRuntimeArn });
    new cdk.CfnOutput(this, 'S3FilesFileSystemId', { value: agentCore.fileSystem.ref });
    new cdk.CfnOutput(this, 'BackendRepoUri', { value: backendRepo.repositoryUri });
    new cdk.CfnOutput(this, 'AgentCoreRepoUri', { value: agentcoreRepo.repositoryUri });
    new cdk.CfnOutput(this, 'AppSecretArn', { value: secrets.appSecret.secretArn });
  }
}
```

- [ ] **Step 2: Verify full stack compiles**

Run: `cd /home/ubuntu/super-agent/infra && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Run CDK synth to validate CloudFormation generation**

Run: `cd /home/ubuntu/super-agent/infra && npx cdk synth --no-lookup 2>&1 | tail -20`
Expected: Synthesizes without fatal errors (warnings about env-agnostic are OK).

- [ ] **Step 4: Commit**

```bash
git add infra/lib/super-agent-stack.ts
git commit -m "feat(infra): rewrite main stack with ECS Fargate + AgentCore + S3 Files"
```

---

## Task 9: Prisma Migration — Add workspace_access_point_arn

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/XXXX_add_workspace_access_point_arn/migration.sql`

- [ ] **Step 1: Add field to schema.prisma**

In `backend/prisma/schema.prisma`, add to the `business_scopes` model (after `visibility` field):

```prisma
  workspace_access_point_arn String?
```

- [ ] **Step 2: Generate migration SQL**

Run: `cd /home/ubuntu/super-agent/backend && npx prisma migrate dev --name add_workspace_access_point_arn --create-only`
Expected: Creates migration file in `prisma/migrations/` with an `ALTER TABLE` statement.

- [ ] **Step 3: Verify migration SQL content**

The generated SQL should contain:
```sql
ALTER TABLE "business_scopes" ADD COLUMN "workspace_access_point_arn" TEXT;
```

- [ ] **Step 4: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/
git commit -m "feat(db): add workspace_access_point_arn to business_scopes"
```

---

## Task 10: S3 Files Service (Backend)

**Files:**
- Create: `backend/src/services/s3files.service.ts`

- [ ] **Step 1: Write S3 Files access point management service**

```typescript
// backend/src/services/s3files.service.ts
import { config } from '../config/index.js';
import { prisma } from '../config/database.js';

interface AccessPointInfo {
  arn: string;
  fileSystemId: string;
}

export class S3FilesService {
  private readonly fileSystemId: string;
  private readonly region: string;
  private readonly account: string;
  private s3FilesClient: any;
  private sdkLoaded = false;

  constructor() {
    this.fileSystemId = config.agentcore.s3FilesFileSystemId ?? '';
    this.region = config.aws.region;
    this.account = '';
  }

  private async ensureSDK(): Promise<void> {
    if (this.sdkLoaded) return;
    try {
      const mod = await import('@aws-sdk/client-s3files' as string);
      this.s3FilesClient = new mod.S3FilesClient({ region: this.region });
      this.sdkLoaded = true;
    } catch (err) {
      throw new Error(`S3 Files SDK not available. Install @aws-sdk/client-s3files. Error: ${err}`);
    }
  }

  async getOrCreateAccessPoint(
    organizationId: string,
    scopeId: string,
  ): Promise<AccessPointInfo> {
    const scope = await prisma.business_scopes.findUnique({
      where: { id: scopeId },
      select: { workspace_access_point_arn: true },
    });

    if (scope?.workspace_access_point_arn) {
      return {
        arn: scope.workspace_access_point_arn,
        fileSystemId: this.fileSystemId,
      };
    }

    await this.ensureSDK();

    const rootDirectory = `/${organizationId}/${scopeId}/`;
    const apName = `scope-${scopeId.replace(/-/g, '').slice(0, 20)}`;

    const { default: mod } = await import('@aws-sdk/client-s3files' as string);
    const response = await this.s3FilesClient.send(
      new mod.CreateAccessPointCommand({
        fileSystemId: this.fileSystemId,
        name: apName,
        rootDirectory: { path: rootDirectory },
        posixUser: { uid: 1000, gid: 1000 },
      }),
    );

    const arn = response.accessPointArn;

    await prisma.business_scopes.update({
      where: { id: scopeId },
      data: { workspace_access_point_arn: arn },
    });

    console.log(`[s3files] Created access point for scope ${scopeId}: ${arn}`);
    return { arn, fileSystemId: this.fileSystemId };
  }

  async deleteAccessPoint(scopeId: string): Promise<void> {
    const scope = await prisma.business_scopes.findUnique({
      where: { id: scopeId },
      select: { workspace_access_point_arn: true },
    });

    if (!scope?.workspace_access_point_arn) return;

    await this.ensureSDK();

    try {
      const { default: mod } = await import('@aws-sdk/client-s3files' as string);
      await this.s3FilesClient.send(
        new mod.DeleteAccessPointCommand({
          accessPointArn: scope.workspace_access_point_arn,
        }),
      );
    } catch (err) {
      console.warn(`[s3files] Failed to delete access point for scope ${scopeId}:`, err);
    }

    await prisma.business_scopes.update({
      where: { id: scopeId },
      data: { workspace_access_point_arn: null },
    });
  }
}

export const s3FilesService = new S3FilesService();
```

- [ ] **Step 2: Add config fields to backend config**

In `backend/src/config/index.ts`, add to the env schema and config object:

```typescript
// In envSchema:
AGENTCORE_S3FILES_FILESYSTEM_ID: z.string().optional(),

// In config.agentcore:
s3FilesFileSystemId: env.AGENTCORE_S3FILES_FILESYSTEM_ID,
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/s3files.service.ts backend/src/config/index.ts
git commit -m "feat(backend): add S3 Files access point management service"
```

---

## Task 11: Simplify agent-runtime-agentcore.ts

**Files:**
- Modify: `backend/src/services/agent-runtime-agentcore.ts`

- [ ] **Step 1: Remove upload/sync methods and integrate S3 Files**

The `runConversation` method needs to:
1. Remove the `uploadWorkspaceIfNeeded` call
2. Remove the `syncBackFromS3` finally block
3. Add S3 Files access point ARN to the invoke payload
4. Remove `uploadedConfigVersions` tracking

Replace the workspace upload section (lines 97-103) with:
```typescript
    // Get S3 Files access point ARN for this scope
    const { s3FilesService } = await import('./s3files.service.js');
    const accessPoint = await s3FilesService.getOrCreateAccessPoint(
      options.organizationId, scopeId,
    );
```

Remove the `finally` block (lines 240-270) that does `syncBackFromS3`.

Add `workspace_access_point_arn: accessPoint.arn` to the payload JSON.

Remove these methods entirely:
- `uploadWorkspaceIfNeeded` (lines 287-318)
- `uploadDirToS3` (lines 381-435)
- `syncBackFromS3` (lines 441-490)

Remove these imports that are no longer needed:
- `PutObjectCommand`, `ListObjectsV2Command`, `GetObjectCommand`
- `createReadStream`, `statSync`, `createWriteStream`
- `readdir`, `mkdir`
- `join`, `relative`, `dirname`
- `pipeline`

Remove the `uploadedConfigVersions` property.

- [ ] **Step 2: Remove S3Client from constructor**

The S3Client and workspaceBucket are no longer needed. Remove:
```typescript
private s3Client: S3Client;
private readonly workspaceBucket: string;
```

And the constructor body that initializes them.

- [ ] **Step 3: Verify the backend still compiles**

Run: `cd /home/ubuntu/super-agent/backend && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/agent-runtime-agentcore.ts
git commit -m "refactor(backend): remove S3 workspace sync from AgentCore runtime, use S3 Files"
```

---

## Task 12: Simplify AgentCore Container

**Files:**
- Modify: `agentcore/src/index.ts`
- Modify: `agentcore/src/agent-runner.ts`
- Delete: `agentcore/src/workspace-sync.ts`
- Delete: `agentcore/src/file-watcher.ts`
- Modify: `agentcore/package.json`
- Modify: `agentcore/Dockerfile`

- [ ] **Step 1: Rewrite agentcore/src/index.ts**

```typescript
// agentcore/src/index.ts
import http from 'http';
import { runAgent } from './agent-runner.js';
import type { AgentPayload, AgentEvent } from './types.js';

const PORT = Number(process.env.PORT ?? 8080);
const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? '/mnt/ws';

async function handleInvocations(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  let payload: AgentPayload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  try {
    for await (const event of runAgent(payload)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err) {
    const errorEvent: AgentEvent = {
      type: 'error',
      code: 'AGENT_EXECUTION_ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
    res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
  }

  res.end();
}

function handlePing(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'Healthy',
    time_of_last_update: Math.floor(Date.now() / 1000),
  }));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/invocations') {
      await handleInvocations(req, res);
    } else if (req.method === 'GET' && req.url === '/ping') {
      handlePing(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (err) {
    console.error('[index] Unhandled error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[agentcore-runner] Listening on 0.0.0.0:${PORT}, workspace=${WORKSPACE_DIR}`);
});
```

- [ ] **Step 2: Simplify agentcore/src/agent-runner.ts**

Remove all S3 sync hooks. Remove imports of `S3Client`, `PutObjectCommand`, `syncWorkspaceToS3`, `syncClaudeHomeToS3`. Remove `createFileChangeHook`, `createBashSyncHook`, `createStopHook`, `extractAndUploadDiff`, `createGitBaseline`, `getModifiedFilesList`. The `WORKSPACE_DIR` constant becomes `process.env.WORKSPACE_DIR ?? '/mnt/ws'`.

The simplified `runAgent` function:

```typescript
// agentcore/src/agent-runner.ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentPayload, AgentEvent, ContentBlock } from './types.js';

const DEFAULT_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'Task', 'Skill',
  'TodoWrite', 'ToolSearch', 'NotebookEdit',
];

const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? '/mnt/ws';

export async function* runAgent(payload: AgentPayload): AsyncGenerator<AgentEvent> {
  const model = payload.model || process.env.ANTHROPIC_MODEL;

  const baseOptions: Record<string, unknown> = {
    systemPrompt: payload.system_prompt ?? undefined,
    allowedTools: payload.allowed_tools ?? DEFAULT_TOOLS,
    cwd: WORKSPACE_DIR,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
    ...(model ? { model } : {}),
  };

  if (payload.mcp_servers && Object.keys(payload.mcp_servers).length > 0) {
    baseOptions.mcpServers = payload.mcp_servers;
  }

  if (payload.session_id) {
    try {
      yield* runWithOptions(payload.prompt, { ...baseOptions, resume: payload.session_id });
      return;
    } catch (err) {
      console.log(`[agent-runner] Session resume failed (${err}), falling back to history injection`);
    }
  }

  const prompt = buildContextualPrompt(payload);
  yield* runWithOptions(prompt, baseOptions);
}

async function* runWithOptions(
  prompt: string,
  options: Record<string, unknown>,
): AsyncGenerator<AgentEvent> {
  for await (const message of query({ prompt, options })) {
    const msg = message as Record<string, unknown>;

    if (msg.type === 'system' && msg.subtype === 'init') {
      yield { type: 'session_start', session_id: msg.session_id as string };
      continue;
    }

    if (msg.type === 'system' && msg.subtype === 'local_command_output') {
      yield {
        type: 'assistant',
        content: [{ type: 'text', text: msg.content as string }],
        session_id: msg.session_id as string | undefined,
      };
      continue;
    }

    if (msg.type === 'assistant') {
      const rawContent = (msg.message as Record<string, unknown>)?.content;
      const blocks = Array.isArray(rawContent) ? rawContent.map(mapContentBlock) : [];
      yield { type: 'assistant', content: blocks, session_id: msg.session_id as string | undefined };
      continue;
    }

    if (msg.type === 'result') {
      const resultMsg = msg as Record<string, unknown>;
      const usage = resultMsg.usage as Record<string, number> | undefined;
      const modelUsage = resultMsg.modelUsage as Record<string, Record<string, number>> | undefined;
      let tokenUsage: import('./types.js').TokenUsage | undefined;

      if (usage) {
        tokenUsage = {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          total_cost_usd: (resultMsg.total_cost_usd as number) ?? 0,
        };
      } else if (modelUsage) {
        let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreation = 0, cost = 0;
        for (const mu of Object.values(modelUsage)) {
          inputTokens += mu.inputTokens ?? 0;
          outputTokens += mu.outputTokens ?? 0;
          cacheRead += mu.cacheReadInputTokens ?? 0;
          cacheCreation += mu.cacheCreationInputTokens ?? 0;
          cost += mu.costUSD ?? 0;
        }
        tokenUsage = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreation,
          total_cost_usd: cost,
        };
      }

      yield {
        type: 'result',
        session_id: msg.session_id as string | undefined,
        duration_ms: msg.duration_ms as number | undefined,
        num_turns: msg.num_turns as number | undefined,
        is_error: msg.is_error as boolean | undefined,
        result: msg.result as string | undefined,
        token_usage: tokenUsage,
      };
      continue;
    }
  }
}

function buildContextualPrompt(payload: AgentPayload): string {
  const history = payload.history;
  if (!history || history.length === 0) return payload.prompt;

  const contextParts = history.map(msg =>
    msg.role === 'user' ? `User: ${msg.content}` : `Assistant: ${msg.content}`,
  );

  return (
    `Here is our conversation so far:\n\n${contextParts.join('\n\n')}\n\n` +
    `Now the user says:\n${payload.prompt}\n\n` +
    `Please respond based on the full conversation context above.`
  );
}

function mapContentBlock(block: Record<string, unknown>): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text as string };
    case 'tool_use':
      return { type: 'tool_use', id: block.id as string, name: block.name as string, input: block.input };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: block.tool_use_id as string, content: block.content as string | undefined, is_error: block.is_error as boolean | undefined };
    default:
      return block as unknown as ContentBlock;
  }
}
```

- [ ] **Step 3: Delete workspace-sync.ts and file-watcher.ts**

Run: `rm agentcore/src/workspace-sync.ts agentcore/src/file-watcher.ts`

- [ ] **Step 4: Update agentcore/package.json — remove @aws-sdk/client-s3**

```json
{
  "name": "super-agent-agentcore-runner",
  "version": "2.0.0",
  "type": "module",
  "description": "AgentCore Runtime container — runs Claude Agent SDK with S3 Files mount",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.34"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  },
  "engines": {
    "node": ">=22"
  }
}
```

- [ ] **Step 5: Update Dockerfile**

```dockerfile
# Super Agent — AgentCore Runtime Container
# Runs Claude Agent SDK inside AWS Bedrock AgentCore with S3 Files mount.
# Implements the AgentCore HTTP protocol (POST /invocations + GET /ping).

FROM public.ecr.aws/docker/library/node:22-slim
WORKDIR /app

RUN apt-get update && apt-get install -y \
    curl git unzip python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages uv

RUN npm install -g @anthropic-ai/claude-code

ENV CLAUDE_CODE_USE_BEDROCK=1 \
    ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-6 \
    WORKSPACE_DIR=/mnt/ws

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

RUN npm prune --omit=dev

RUN mkdir -p /mnt/ws /mnt/session
RUN chown -R node:node /mnt/ws /mnt/session /app

USER node

EXPOSE 8080

CMD ["node", "/app/dist/index.js"]
```

- [ ] **Step 6: Verify agentcore compiles**

Run: `cd /home/ubuntu/super-agent/agentcore && npm install && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
git add -A agentcore/
git commit -m "refactor(agentcore): remove S3 sync, use S3 Files mount at /mnt/ws"
```

---

## Task 13: Verify Full Stack Synthesis

**Files:**
- No new files — validation only.

- [ ] **Step 1: Run full CDK synth**

Run: `cd /home/ubuntu/super-agent/infra && npx cdk synth --no-lookup 2>&1 | tail -30`
Expected: Successful synthesis. May produce large CloudFormation template output.

- [ ] **Step 2: Validate resource count is reasonable**

Run: `cd /home/ubuntu/super-agent/infra && npx cdk synth --no-lookup 2>/dev/null | grep -c "Type.*AWS::"`
Expected: ~40-60 resources (VPC subnets, NAT, ECS, ALB, security groups, etc.)

- [ ] **Step 3: Run backend TypeScript check**

Run: `cd /home/ubuntu/super-agent/backend && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Run agentcore TypeScript check**

Run: `cd /home/ubuntu/super-agent/agentcore && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Final commit if any fixups were needed**

```bash
git add -A && git commit -m "fix: resolve type errors from integration" --allow-empty
```

---

## Task 14: Backend Dockerfile for ECS

**Files:**
- Create: `backend/Dockerfile`

- [ ] **Step 1: Write production Dockerfile for backend**

```dockerfile
# Super Agent Backend — ECS Fargate Production Image
FROM public.ecr.aws/docker/library/node:22-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY prisma/ ./prisma/

RUN npx prisma generate
RUN npx tsc

# Production stage
FROM public.ecr.aws/docker/library/node:22-slim
WORKDIR /app

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma/ ./prisma/
COPY skills/ ./skills/

USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Commit**

```bash
git add backend/Dockerfile
git commit -m "feat(backend): add production Dockerfile for ECS Fargate"
```

---

## Summary of Commits

1. `chore(infra): upgrade CDK to v2.257 for AgentCore + S3 Files support`
2. `feat(infra): add VPC construct with 3-tier subnets and endpoints`
3. `feat(infra): add data layer construct with Aurora PostgreSQL + Redis Multi-AZ`
4. `feat(infra): add Secrets Manager construct for app configuration`
5. `feat(infra): add AgentCore construct with CfnRuntime + S3 Files FileSystem`
6. `feat(infra): add ECS Fargate construct with api/worker/gateway services`
7. `feat(infra): add CloudFront CDN construct with VPC Origin and WAF`
8. `feat(infra): rewrite main stack with ECS Fargate + AgentCore + S3 Files`
9. `feat(db): add workspace_access_point_arn to business_scopes`
10. `feat(backend): add S3 Files access point management service`
11. `refactor(backend): remove S3 workspace sync from AgentCore runtime, use S3 Files`
12. `refactor(agentcore): remove S3 sync, use S3 Files mount at /mnt/ws`
13. `fix: resolve type errors from integration`
14. `feat(backend): add production Dockerfile for ECS Fargate`
