import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { CfnFileSystem, CfnAccessPoint, CfnMountTarget } from 'aws-cdk-lib/aws-s3files';
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';

export interface AgentCoreConstructProps {
  workspaceBucket: s3.IBucket;
  containerUri: string;
  vpc: ec2.IVpc;
  ecsSecurityGroup: ec2.ISecurityGroup;
  region: string;
  account: string;
}

export class AgentCoreConstruct extends Construct {
  public readonly runtime: CfnRuntime;
  public readonly executionRole: iam.Role;
  public readonly fileSystem: CfnFileSystem;
  public readonly accessPoint: CfnAccessPoint;
  public readonly s3FilesRole: iam.Role;

  constructor(scope: Construct, id: string, props: AgentCoreConstructProps) {
    super(scope, id);

    // S3 Files Role - assumed by the S3 Files service to sync the file system
    // with the backing bucket. S3 Files is implemented on top of Amazon EFS, so
    // the trust principal is 'elasticfilesystem.amazonaws.com' (NOT
    // 's3files.amazonaws.com', which IAM rejects as an invalid principal, nor
    // 'bedrock-agentcore.amazonaws.com', which S3 Files cannot assume).
    // Trust + permission policies follow the S3 Files prerequisites doc:
    // https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-prereq-policies.html
    this.s3FilesRole = new iam.Role(this, 'S3FilesRole', {
      assumedBy: new iam.ServicePrincipal('elasticfilesystem.amazonaws.com', {
        conditions: {
          StringEquals: {
            'aws:SourceAccount': props.account,
          },
          ArnLike: {
            'aws:SourceArn': `arn:aws:s3files:${props.region}:${props.account}:file-system/*`,
          },
        },
      }),
      description: 'Role assumed by S3 Files to sync the workspace bucket',
    });

    const workspaceBucketArn = props.workspaceBucket.bucketArn;

    // S3 bucket/object permissions (incl. ListBucketVersions required by S3 Files sync).
    this.s3FilesRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3BucketPermissions',
        actions: ['s3:ListBucket', 's3:ListBucketVersions'],
        resources: [workspaceBucketArn],
        conditions: { StringEquals: { 'aws:ResourceAccount': props.account } },
      })
    );
    this.s3FilesRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3ObjectPermissions',
        actions: [
          's3:AbortMultipartUpload',
          's3:DeleteObject*',
          's3:GetObject*',
          's3:List*',
          's3:PutObject*',
        ],
        resources: [`${workspaceBucketArn}/*`],
        conditions: { StringEquals: { 'aws:ResourceAccount': props.account } },
      })
    );

    // EventBridge rules that S3 Files manages to detect bucket changes.
    this.s3FilesRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EventBridgeManage',
        actions: [
          'events:DeleteRule',
          'events:DisableRule',
          'events:EnableRule',
          'events:PutRule',
          'events:PutTargets',
          'events:RemoveTargets',
        ],
        resources: ['arn:aws:events:*:*:rule/DO-NOT-DELETE-S3-Files*'],
        conditions: {
          StringEquals: { 'events:ManagedBy': 'elasticfilesystem.amazonaws.com' },
        },
      })
    );
    this.s3FilesRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EventBridgeRead',
        actions: [
          'events:DescribeRule',
          'events:ListRuleNamesByTarget',
          'events:ListRules',
          'events:ListTargetsByRule',
        ],
        resources: ['arn:aws:events:*:*:rule/*'],
      })
    );

    // S3 Files FileSystem
    this.fileSystem = new CfnFileSystem(this, 'FileSystem', {
      // CfnFileSystem.Bucket must be a full S3 ARN (pattern ^arn:aws[a-zA-Z0-9-]*:s3:::.+$),
      // not a bare bucket name.
      bucket: props.workspaceBucket.bucketArn,
      roleArn: this.s3FilesRole.roleArn,
      // The workspace bucket already contains objects; acknowledge the
      // non-empty-bucket warning so filesystem creation isn't blocked.
      acceptBucketWarning: true,
    });

    // S3 Files Access Point (required for AgentCore filesystem mount)
    this.accessPoint = new CfnAccessPoint(this, 'AccessPoint', {
      fileSystemId: this.fileSystem.ref,
    });
    this.accessPoint.addDependency(this.fileSystem);

    // S3 Files Mount Targets (one per private subnet, required for VPC mode)
    const privateSubnets = props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS });
    privateSubnets.subnetIds.forEach((subnetId, index) => {
      const mt = new CfnMountTarget(this, `MountTarget${index}`, {
        fileSystemId: this.fileSystem.ref,
        subnetId,
        securityGroups: [props.ecsSecurityGroup.securityGroupId],
      });
      mt.addDependency(this.fileSystem);
    });

    // AgentCore Execution Role - assumed by bedrock-agentcore.amazonaws.com (with confused deputy protection)
    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: {
            'aws:SourceAccount': props.account,
          },
        },
      }),
      description: 'Execution role for AgentCore runtime',
    });

    // Grant Bedrock model invocation permissions
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [`arn:aws:bedrock:${props.region}::foundation-model/anthropic.*`],
      })
    );

    // Grant workspace bucket read/write (no delete — S3 Files role handles filesystem ops)
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [props.workspaceBucket.arnForObjects('*')],
      })
    );
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [props.workspaceBucket.bucketArn],
      })
    );

    // Grant ECR pull permissions (AgentCore needs to pull the container image)
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      })
    );
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
        resources: [`arn:aws:ecr:${props.region}:${props.account}:repository/*`],
      })
    );

    // Grant S3 Files permissions (required for filesystem mount in AgentCore)
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3files:*'],
        resources: [`arn:aws:s3files:${props.region}:${props.account}:file-system/*`],
      })
    );

    // Grant CloudWatch Logs write permissions
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: [
          `arn:aws:logs:${props.region}:${props.account}:log-group:/aws/bedrock/agentcore/*`,
        ],
      })
    );

    // AgentCore Runtime
    this.runtime = new CfnRuntime(this, 'Runtime', {
      // agentRuntimeName must match [a-zA-Z][a-zA-Z0-9_]{0,47} — no hyphens.
      agentRuntimeName: 'super_agent_runtime',
      roleArn: this.executionRole.roleArn,
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: props.containerUri,
        },
      },
      networkConfiguration: {
        networkMode: 'VPC',
        networkModeConfig: {
          subnets: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
          securityGroups: [props.ecsSecurityGroup.securityGroupId],
        },
      },
      filesystemConfigurations: [
        {
          sessionStorage: {
            mountPath: '/mnt/session',
          },
        },
        {
          s3FilesAccessPoint: {
            accessPointArn: this.accessPoint.attrAccessPointArn,
            mountPath: '/mnt/ws',
          },
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

    this.runtime.node.addDependency(this.executionRole);
    this.runtime.node.addDependency(this.fileSystem);
    this.runtime.node.addDependency(this.accessPoint);
  }
}
