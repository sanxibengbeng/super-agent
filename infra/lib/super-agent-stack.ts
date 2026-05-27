import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';
import { VpcConstruct } from './constructs/vpc';
import { DataLayerConstruct } from './constructs/data-layer';
import { SecretsConstruct } from './constructs/secrets';
import { AgentCoreConstruct } from './constructs/agentcore';
import { EcsClusterConstruct } from './constructs/ecs-cluster';
import { CdnConstruct } from './constructs/cdn';

export class SuperAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =========================================================================
    // VPC (3-tier: public, private, isolated)
    // =========================================================================
    const network = new VpcConstruct(this, 'Network');

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
          noncurrentVersionTransitions: [{
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
    // Data Layer (Aurora PostgreSQL + ElastiCache Redis)
    // =========================================================================
    const dataLayer = new DataLayerConstruct(this, 'Data', {
      vpc: network.vpc,
      dbSecurityGroup: network.dbSecurityGroup,
      redisSecurityGroup: network.redisSecurityGroup,
    });

    // =========================================================================
    // Secrets Manager
    // =========================================================================
    const secrets = new SecretsConstruct(this, 'Secrets', {
      dbSecretArn: dataLayer.dbSecret.secretArn,
    });

    // =========================================================================
    // AgentCore Runtime + S3 Files
    // =========================================================================
    const agentCore = new AgentCoreConstruct(this, 'AgentCore', {
      workspaceBucket,
      containerUri: `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${agentcoreRepo.repositoryName}:latest`,
      region: this.region,
      account: this.account,
    });

    // =========================================================================
    // ECS Fargate Cluster (api + worker + gateway)
    // =========================================================================
    const ecsCluster = new EcsClusterConstruct(this, 'Ecs', {
      vpc: network.vpc,
      ecsSecurityGroup: network.ecsSecurityGroup,
      albSecurityGroup: network.albSecurityGroup,
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
    // CloudFront CDN + WAF (VPC Origin → internal ALB)
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
