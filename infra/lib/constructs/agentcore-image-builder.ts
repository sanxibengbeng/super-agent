import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

export interface AgentCoreImageBuilderProps {
  agentcoreRepo: ecr.IRepository;
  sourceDirectory: string;
  region: string;
  account: string;
}

export class AgentCoreImageBuilderConstruct extends Construct {
  public readonly project: codebuild.Project;
  public readonly buildTrigger: cdk.CustomResource;

  constructor(scope: Construct, id: string, props: AgentCoreImageBuilderProps) {
    super(scope, id);

    const ecrUri = `${props.account}.dkr.ecr.${props.region}.amazonaws.com/${props.agentcoreRepo.repositoryName}`;

    // Package agentcore source as S3 Asset (hash-based change detection)
    const sourceAsset = new s3_assets.Asset(this, 'Source', {
      path: path.resolve(props.sourceDirectory),
      exclude: ['node_modules', 'dist', '.git', '*.log'],
    });

    // CodeBuild project — ARM64 native, privileged for Docker
    this.project = new codebuild.Project(this, 'Project', {
      projectName: 'super-agent-agentcore-builder',
      description: 'Builds AgentCore ARM64 container image and pushes to ECR',
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        computeType: codebuild.ComputeType.LARGE,
        privileged: true,
      },
      timeout: cdk.Duration.minutes(15),
      source: codebuild.Source.s3({
        bucket: sourceAsset.bucket,
        path: sourceAsset.s3ObjectKey,
      }),
      environmentVariables: {
        ECR_URI: { value: ecrUri },
        AWS_ACCOUNT_ID: { value: props.account },
        AWS_DEFAULT_REGION: { value: props.region },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo "Logging into ECR..."',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com',
            ],
          },
          build: {
            commands: [
              'echo "Building AgentCore image (ARM64, BuildKit disabled)..."',
              'DOCKER_BUILDKIT=0 docker build --platform linux/arm64 -t $ECR_URI:latest -t $ECR_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION .',
            ],
          },
          post_build: {
            commands: [
              'echo "Pushing to ECR..."',
              'docker push $ECR_URI:latest',
              'docker push $ECR_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION',
              'echo "Build complete: $ECR_URI:latest"',
            ],
          },
        },
      }),
    });

    // Grant CodeBuild permission to push to ECR
    props.agentcoreRepo.grantPullPush(this.project);

    // Grant CodeBuild permission to read source from S3 Asset bucket
    sourceAsset.grantRead(this.project);

    // Custom Resource Lambda — starts CodeBuild and polls until complete
    const triggerFunction = new lambda.Function(this, 'TriggerFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(15),
      code: lambda.Code.fromInline(`
const { CodeBuildClient, StartBuildCommand, BatchGetBuildsCommand } = require('@aws-sdk/client-codebuild');

const client = new CodeBuildClient();

async function waitForBuild(buildId) {
  while (true) {
    const resp = await client.send(new BatchGetBuildsCommand({ ids: [buildId] }));
    const build = resp.builds[0];
    const status = build.buildStatus;
    if (status === 'SUCCEEDED') return;
    if (status === 'FAILED' || status === 'FAULT' || status === 'STOPPED' || status === 'TIMED_OUT') {
      throw new Error('CodeBuild failed: ' + status + ' — ' + (build.phases?.find(p => p.phaseStatus === 'FAILED')?.contexts?.[0]?.message || 'unknown'));
    }
    await new Promise(r => setTimeout(r, 10000));
  }
}

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event));
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId || 'deleted' };
  }
  const projectName = event.ResourceProperties.ProjectName;
  const sourceHash = event.ResourceProperties.SourceHash;
  console.log('Starting build for project:', projectName, 'hash:', sourceHash);
  const startResp = await client.send(new StartBuildCommand({ projectName }));
  const buildId = startResp.build.id;
  console.log('Build started:', buildId);
  await waitForBuild(buildId);
  console.log('Build succeeded:', buildId);
  return { PhysicalResourceId: buildId, Data: { BuildId: buildId } };
};
`),
    });

    // Grant Lambda permission to start and monitor CodeBuild
    triggerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
        resources: [this.project.projectArn],
      })
    );

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: triggerFunction,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // Custom Resource — sourceHash in properties ensures re-trigger on source change
    this.buildTrigger = new cdk.CustomResource(this, 'BuildTrigger', {
      serviceToken: provider.serviceToken,
      properties: {
        ProjectName: this.project.projectName,
        SourceHash: sourceAsset.assetHash,
      },
    });
  }
}
