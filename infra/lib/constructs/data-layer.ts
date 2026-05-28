import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface DataLayerProps {
  vpc: ec2.Vpc;
  dbSecurityGroup: ec2.SecurityGroup;
  redisSecurityGroup: ec2.SecurityGroup;
}

export class DataLayerConstruct extends Construct {
  public readonly dbCluster: rds.DatabaseCluster;
  public readonly dbSecret: secretsmanager.ISecret;
  public readonly redisEndpoint: string;
  public readonly redisPort: number;
  public readonly redisAuthSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: DataLayerProps) {
    super(scope, id);

    // Aurora PostgreSQL 16 Cluster
    this.dbCluster = new rds.DatabaseCluster(this, 'DbCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_6,
      }),
      writer: rds.ClusterInstance.provisioned('Writer', {
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.T4G,
          ec2.InstanceSize.MEDIUM
        ),
        publiclyAccessible: false,
        enablePerformanceInsights: true,
      }),
      readers: [
        rds.ClusterInstance.provisioned('Reader1', {
          instanceType: ec2.InstanceType.of(
            ec2.InstanceClass.T4G,
            ec2.InstanceSize.MEDIUM
          ),
          publiclyAccessible: false,
          enablePerformanceInsights: true,
        }),
      ],
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [props.dbSecurityGroup],
      defaultDatabaseName: 'superagent',
      storageEncrypted: true,
      deletionProtection: true,
      cloudwatchLogsExports: ['postgresql'],
      backup: {
        retention: cdk.Duration.days(7),
        preferredWindow: '03:00-04:00',
      },
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    this.dbSecret = this.dbCluster.secret!;

    // Redis AUTH token stored in Secrets Manager
    this.redisAuthSecret = new secretsmanager.Secret(this, 'RedisAuthSecret', {
      description: 'AUTH token for ElastiCache Redis',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 64,
      },
    });

    // ElastiCache Redis 7.1 Replication Group
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(
      this,
      'RedisSubnetGroup',
      {
        description: 'Subnet group for ElastiCache Redis',
        subnetIds: props.vpc.isolatedSubnets.map((subnet) => subnet.subnetId),
        cacheSubnetGroupName: 'super-agent-redis-subnet-group',
      }
    );

    const redisReplicationGroup = new elasticache.CfnReplicationGroup(
      this,
      'RedisReplicationGroup',
      {
        replicationGroupDescription: 'Super Agent Redis cluster',
        engine: 'redis',
        engineVersion: '7.1',
        cacheNodeType: 'cache.t4g.micro',
        numCacheClusters: 2, // 1 primary + 1 replica
        automaticFailoverEnabled: true,
        multiAzEnabled: true,
        cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName,
        securityGroupIds: [props.redisSecurityGroup.securityGroupId],
        atRestEncryptionEnabled: true,
        transitEncryptionEnabled: true,
        transitEncryptionMode: 'required',
        authToken: this.redisAuthSecret.secretValue.unsafeUnwrap(),
        snapshotRetentionLimit: 5,
        snapshotWindow: '03:00-05:00',
        preferredMaintenanceWindow: 'mon:05:00-mon:07:00',
      }
    );
    redisReplicationGroup.addDependency(redisSubnetGroup);
    redisReplicationGroup.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // Export Redis connection details
    this.redisEndpoint = redisReplicationGroup.attrPrimaryEndPointAddress;
    this.redisPort = 6379;

    // Outputs
    new cdk.CfnOutput(this, 'DatabaseClusterEndpoint', {
      value: this.dbCluster.clusterEndpoint.hostname,
      description: 'Aurora PostgreSQL cluster endpoint',
    });

    new cdk.CfnOutput(this, 'DatabaseSecretArn', {
      value: this.dbSecret.secretArn,
      description: 'Database credentials secret ARN',
    });

    new cdk.CfnOutput(this, 'RedisEndpoint', {
      value: this.redisEndpoint,
      description: 'ElastiCache Redis primary endpoint',
    });

    new cdk.CfnOutput(this, 'RedisPort', {
      value: this.redisPort.toString(),
      description: 'ElastiCache Redis port',
    });

    new cdk.CfnOutput(this, 'RedisAuthSecretArn', {
      value: this.redisAuthSecret.secretArn,
      description: 'Redis AUTH token secret ARN',
    });
  }
}
