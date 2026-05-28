import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { CfnFileSystem } from 'aws-cdk-lib/aws-s3files';
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';

export interface AgentCoreConstructProps {
  workspaceBucket: s3.IBucket;
  containerUri: string;
  region: string;
  account: string;
}

export class AgentCoreConstruct extends Construct {
  public readonly runtime: CfnRuntime;
  public readonly executionRole: iam.Role;
  public readonly fileSystem: CfnFileSystem;
  public readonly s3FilesRole: iam.Role;

  constructor(scope: Construct, id: string, props: AgentCoreConstructProps) {
    super(scope, id);

    // S3 Files Role - assumed by s3files.amazonaws.com (with confused deputy protection)
    this.s3FilesRole = new iam.Role(this, 'S3FilesRole', {
      assumedBy: new iam.ServicePrincipal('s3files.amazonaws.com', {
        conditions: {
          StringEquals: {
            'aws:SourceAccount': props.account,
          },
        },
      }),
      description: 'Role for S3 Files to access workspace bucket',
    });

    props.workspaceBucket.grantReadWrite(this.s3FilesRole);

    // S3 Files FileSystem
    this.fileSystem = new CfnFileSystem(this, 'FileSystem', {
      bucket: props.workspaceBucket.bucketName,
      roleArn: this.s3FilesRole.roleArn,
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
          sessionStorage: {
            mountPath: '/mnt/session',
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
  }
}
