import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Duration } from 'aws-cdk-lib';

export interface EcsClusterConstructProps {
  vpc: ec2.IVpc;
  ecsSecurityGroup: ec2.ISecurityGroup;
  albSecurityGroup: ec2.ISecurityGroup;
  dbSecret: secretsmanager.ISecret;
  appSecret: secretsmanager.ISecret;
  redisAuthSecret: secretsmanager.ISecret;
  redisEndpoint: string;
  redisPort: number;
  backendRepo: ecr.IRepository;
  workspaceBucket: s3.IBucket;
  workspaceBucketName: string;
  assetsBucketName: string;
  agentCoreRuntimeArn: string;
  s3FilesFileSystemId: string;
  region: string;
  account: string;
  envName: string;
  otelEndpoint?: string;
  agentRuntime?: string;
}

export class EcsClusterConstruct extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly apiService: ecs.FargateService;
  public readonly workerService: ecs.FargateService;
  public readonly gatewayService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: EcsClusterConstructProps) {
    super(scope, id);

    // ECS Cluster
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: `super-agent-${props.envName}`,
      containerInsights: true,
    });

    // Internal Application Load Balancer (private subnets)
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc: props.vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: props.albSecurityGroup,
      idleTimeout: Duration.seconds(3600), // For WebSocket connections
    });

    // Enable ALB access logs to workspace bucket
    this.alb.logAccessLogs(props.workspaceBucket, 'alb-logs');

    // HTTP Listener on port 80
    const listener = this.alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not Found',
      }),
    });

    // CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/super-agent/${props.envName}/ecs`,
      retention: logs.RetentionDays.THREE_MONTHS,
    });

    // Shared Execution Role (for pulling container images and reading secrets)
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS Task Execution Role',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Grant execution role permission to read secrets
    props.dbSecret.grantRead(executionRole);
    props.appSecret.grantRead(executionRole);
    props.redisAuthSecret.grantRead(executionRole);

    // Shared environment variables
    const sharedEnvironment: Record<string, string> = {
      NODE_ENV: 'production',
      PORT: '3000',
      REDIS_HOST: props.redisEndpoint,
      REDIS_PORT: props.redisPort.toString(),
      REDIS_TLS: 'true',
      AWS_REGION: props.region,
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_MODEL: 'global.anthropic.claude-sonnet-4-6',
      WORKSPACE_BUCKET_NAME: props.workspaceBucketName,
      ASSETS_BUCKET_NAME: props.assetsBucketName,
      AGENTCORE_RUNTIME_ARN: props.agentCoreRuntimeArn,
      AGENTCORE_S3FILES_FILESYSTEM_ID: props.s3FilesFileSystemId,
      AGENTCORE_WORKSPACE_S3_BUCKET: props.workspaceBucketName,
      OTEL_EXPORTER_OTLP_ENDPOINT: props.otelEndpoint ?? '',
      OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '0.1',
      OTEL_METRICS_EXPORT_INTERVAL: '60000',
      AGENT_RUNTIME: props.agentRuntime || 'claude',
    };

    // Shared secrets from Secrets Manager
    const sharedSecrets: Record<string, ecs.Secret> = {
      DATABASE_URL: ecs.Secret.fromSecretsManager(props.dbSecret, 'connectionString'),
      JWT_SECRET: ecs.Secret.fromSecretsManager(props.appSecret),
      REDIS_PASSWORD: ecs.Secret.fromSecretsManager(props.redisAuthSecret),
      OTEL_EXPORTER_OTLP_HEADERS: ecs.Secret.fromSecretsManager(props.appSecret, 'OTEL_EXPORTER_OTLP_HEADERS'),
    };

    const containerImage = ecs.ContainerImage.fromEcrRepository(props.backendRepo, 'latest');

    // ============================================
    // API Service (PROCESS_ROLE=api)
    // ============================================
    const apiTaskDefinition = new ecs.FargateTaskDefinition(this, 'ApiTaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole,
    });

    // Bedrock model invocation (for Claude Agent SDK)
    apiTaskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${props.region}::foundation-model/anthropic.*`,
          `arn:aws:bedrock:${props.region}::foundation-model/us.anthropic.*`,
          `arn:aws:bedrock:${props.region}:${props.account}:inference-profile/*`,
          `arn:aws:bedrock:*::foundation-model/*`,
        ],
      })
    );

    // AgentCore invoke permissions (API service calls AgentCore for chat)
    // Resource needs wildcard suffix — SDK requests include /runtime-endpoint/DEFAULT subpath
    if (props.agentCoreRuntimeArn) {
      apiTaskDefinition.addToTaskRolePolicy(
        new iam.PolicyStatement({
          actions: [
            'bedrock-agentcore:InvokeAgentRuntime',
            'bedrock-agentcore:StopRuntimeSession',
          ],
          resources: [props.agentCoreRuntimeArn, `${props.agentCoreRuntimeArn}/*`],
        })
      );
    }

    // S3 Files access point management (for AgentCore workspace mounts)
    if (props.s3FilesFileSystemId) {
      apiTaskDefinition.addToTaskRolePolicy(
        new iam.PolicyStatement({
          actions: [
            's3files:CreateAccessPoint',
            's3files:GetAccessPoint',
            's3files:DeleteAccessPoint',
            's3files:ListAccessPoints',
          ],
          resources: [`arn:aws:s3files:${props.region}:${props.account}:file-system/*`],
        })
      );
    }

    // Workspace bucket: full access (read, write, delete, list)
    apiTaskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
        resources: [
          `arn:aws:s3:::${props.workspaceBucketName}`,
          `arn:aws:s3:::${props.workspaceBucketName}/*`,
        ],
      })
    );

    // Assets bucket: read, write, and list (no delete)
    apiTaskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
        resources: [
          `arn:aws:s3:::${props.assetsBucketName}`,
          `arn:aws:s3:::${props.assetsBucketName}/*`,
        ],
      })
    );

    const apiContainer = apiTaskDefinition.addContainer('ApiContainer', {
      image: containerImage,
      environment: {
        ...sharedEnvironment,
        PROCESS_ROLE: 'api',
        OTEL_SERVICE_NAME: 'super-agent-api',
      },
      secrets: sharedSecrets,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'api',
        logGroup,
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
      },
    });

    apiContainer.addPortMappings({ containerPort: 3000 });

    this.apiService = new ecs.FargateService(this, 'ApiService', {
      cluster: this.cluster,
      taskDefinition: apiTaskDefinition,
      desiredCount: 2,
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // API Target Group
    const apiTargetGroup = listener.addTargets('ApiTargets', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.apiService],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        path: '/health',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: '200',
      },
      priority: 10,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/*', '/health', '/v1/*']),
      ],
    });

    // Auto-scaling for API service
    const apiScaling = this.apiService.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 6,
    });

    apiScaling.scaleOnCpuUtilization('ApiCpuScaling', {
      targetUtilizationPercent: 70,
    });

    // ============================================
    // Worker Service (PROCESS_ROLE=worker)
    // ============================================
    const workerTaskDefinition = new ecs.FargateTaskDefinition(this, 'WorkerTaskDef', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      executionRole,
    });

    // Bedrock model invocation (for Claude Agent SDK in worker)
    workerTaskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${props.region}::foundation-model/anthropic.*`,
          `arn:aws:bedrock:${props.region}::foundation-model/us.anthropic.*`,
          `arn:aws:bedrock:${props.region}:${props.account}:inference-profile/*`,
          `arn:aws:bedrock:*::foundation-model/*`,
        ],
      })
    );

    // Set task role with AgentCore, S3 Files, and S3 workspace access
    // Resource needs wildcard suffix — SDK requests include /runtime-endpoint/DEFAULT subpath
    if (props.agentCoreRuntimeArn) {
      workerTaskDefinition.addToTaskRolePolicy(
        new iam.PolicyStatement({
          actions: [
            'bedrock-agentcore:InvokeAgentRuntime',
            'bedrock-agentcore:CreateAgentRuntimeSession',
            'bedrock-agentcore:GetAgentRuntimeSession',
            'bedrock-agentcore:DeleteAgentRuntimeSession',
          ],
          resources: [props.agentCoreRuntimeArn, `${props.agentCoreRuntimeArn}/*`],
        })
      );
    }

    if (props.s3FilesFileSystemId) {
      workerTaskDefinition.addToTaskRolePolicy(
        new iam.PolicyStatement({
          actions: [
            's3files:CreateAccessPoint',
            's3files:DescribeAccessPoint',
            's3files:DeleteAccessPoint',
          ],
          resources: [`arn:aws:s3files:${props.region}:${props.account}:filesystem/${props.s3FilesFileSystemId}`],
        })
      );
    }

    workerTaskDefinition.addToTaskRolePolicy(
      new iam.PolicyStatement({
        actions: [
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject',
          's3:ListBucket',
          's3:GetBucketLocation',
        ],
        resources: [
          `arn:aws:s3:::${props.workspaceBucketName}`,
          `arn:aws:s3:::${props.workspaceBucketName}/*`,
        ],
      })
    );

    const workerContainer = workerTaskDefinition.addContainer('WorkerContainer', {
      image: containerImage,
      environment: {
        ...sharedEnvironment,
        PROCESS_ROLE: 'worker',
        OTEL_SERVICE_NAME: 'super-agent-worker',
      },
      secrets: sharedSecrets,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'worker',
        logGroup,
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
      },
      stopTimeout: Duration.seconds(120),
    });

    workerContainer.addPortMappings({ containerPort: 3000 });

    this.workerService = new ecs.FargateService(this, 'WorkerService', {
      cluster: this.cluster,
      taskDefinition: workerTaskDefinition,
      desiredCount: 1,
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // Auto-scaling for Worker service
    const workerScaling = this.workerService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 4,
    });

    workerScaling.scaleOnCpuUtilization('WorkerCpuScaling', {
      targetUtilizationPercent: 70,
    });

    // ============================================
    // Gateway Service (PROCESS_ROLE=gateway)
    // ============================================
    const gatewayTaskDefinition = new ecs.FargateTaskDefinition(this, 'GatewayTaskDef', {
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole,
    });

    // Gateway Task Role - minimal permissions (Redis only, no additional policies needed)

    const gatewayContainer = gatewayTaskDefinition.addContainer('GatewayContainer', {
      image: containerImage,
      environment: {
        ...sharedEnvironment,
        PROCESS_ROLE: 'gateway',
        OTEL_SERVICE_NAME: 'super-agent-gateway',
      },
      secrets: sharedSecrets,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'gateway',
        logGroup,
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
      },
      stopTimeout: Duration.seconds(120),
    });

    gatewayContainer.addPortMappings({ containerPort: 3000 });

    this.gatewayService = new ecs.FargateService(this, 'GatewayService', {
      cluster: this.cluster,
      taskDefinition: gatewayTaskDefinition,
      desiredCount: 2,
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // Gateway Target Group with stickiness for WebSocket connections
    const gatewayTargetGroup = listener.addTargets('GatewayTargets', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.gatewayService],
      deregistrationDelay: Duration.seconds(120),
      healthCheck: {
        path: '/health',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: '200',
      },
      stickinessCookieDuration: Duration.hours(1),
      priority: 5,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/ws/*']),
      ],
    });

    // Auto-scaling for Gateway service
    const gatewayScaling = this.gatewayService.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 4,
    });

    gatewayScaling.scaleOnCpuUtilization('GatewayCpuScaling', {
      targetUtilizationPercent: 70,
    });

    // ============================================
    // CloudWatch Alarms
    // ============================================

    // API Service CPU utilization > 80% for 3 minutes
    new cloudwatch.Alarm(this, 'ApiCpuAlarm', {
      alarmName: `super-agent-${props.envName}-api-cpu-high`,
      alarmDescription: 'API service CPU utilization exceeds 80% for 3 minutes',
      metric: this.apiService.metricCpuUtilization({
        period: Duration.minutes(1),
        statistic: 'Average',
      }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // API 5xx responses > 10 in 5 minutes
    new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      alarmName: `super-agent-${props.envName}-api-5xx-high`,
      alarmDescription: 'API target group 5xx responses exceed 10 in 5 minutes',
      metric: apiTargetGroup.metrics.httpCodeTarget(
        elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
        {
          period: Duration.minutes(5),
          statistic: 'Sum',
        }
      ),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // ALB unhealthy host count > 0 for 2 minutes
    new cloudwatch.Alarm(this, 'AlbUnhealthyHostsAlarm', {
      alarmName: `super-agent-${props.envName}-alb-unhealthy-hosts`,
      alarmDescription: 'ALB has unhealthy hosts for 2 minutes',
      metric: apiTargetGroup.metrics.unhealthyHostCount({
        period: Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 0,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
  }
}
