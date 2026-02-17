import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

export class SuperAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =========================================================================
    // Parameters
    // =========================================================================
    const keyPairName = new cdk.CfnParameter(this, 'KeyPairName', {
      type: 'String',
      default: 'super-agent-key',
      description: 'EC2 Key Pair name for SSH access',
    });

    const adminEmail = new cdk.CfnParameter(this, 'AdminEmail', {
      type: 'String',
      default: 'admin@example.com',
      description: 'Email for the initial admin user in Cognito',
    });

    const cognitoDomainPrefix = new cdk.CfnParameter(this, 'CognitoDomainPrefix', {
      type: 'String',
      default: 'super-agent',
      description: 'Cognito Hosted UI domain prefix (must be globally unique)',
    });

    // =========================================================================
    // VPC — use the default VPC
    // =========================================================================
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // =========================================================================
    // Security Groups
    // =========================================================================
    const ec2Sg = new ec2.SecurityGroup(this, 'EC2SG', {
      vpc,
      description: 'Super Agent EC2',
      allowAllOutbound: true,
    });
    ec2Sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'SSH');
    ec2Sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');
    ec2Sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    ec2Sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3000), 'Backend API (dev)');

    const dbSg = new ec2.SecurityGroup(this, 'AuroraDBSG', {
      vpc,
      description: 'Aurora PostgreSQL',
      allowAllOutbound: false,
    });
    dbSg.addIngressRule(ec2Sg, ec2.Port.tcp(5432), 'PostgreSQL from EC2');

    // =========================================================================
    // Cognito User Pool
    // =========================================================================
    const userPool = new cognito.UserPool(this, 'SuperAgentUserPool', {
      userPoolName: 'super-agent-users',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      customAttributes: {
        orgId: new cognito.StringAttribute({ mutable: true }),
        role: new cognito.StringAttribute({ mutable: true }),
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Cognito domain for Hosted UI
    const cognitoDomain = userPool.addDomain('CognitoDomain', {
      cognitoDomain: {
        domainPrefix: cognitoDomainPrefix.valueAsString,
      },
    });

    // App Client — public client for SPA (PKCE, no secret)
    // Callback/sign-out URLs use a placeholder; update after getting the Elastic IP
    const appClient = userPool.addClient('SuperAgentAppClient', {
      userPoolClientName: 'super-agent-web',
      generateSecret: false,
      authFlows: {
        userSrp: true,
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        // Placeholder URLs — updated by the post-deploy script
        callbackUrls: [
          'http://localhost:5173/auth/callback',
        ],
        logoutUrls: [
          'http://localhost:5173/login',
        ],
      },
      preventUserExistenceErrors: true,
    });

    // Create the initial admin user (they'll receive an email to set password)
    const adminUser = new cognito.CfnUserPoolUser(this, 'AdminUser', {
      userPoolId: userPool.userPoolId,
      username: adminEmail.valueAsString,
      userAttributes: [
        { name: 'email', value: adminEmail.valueAsString },
        { name: 'email_verified', value: 'true' },
      ],
      desiredDeliveryMediums: ['EMAIL'],
    });

    // =========================================================================
    // Aurora PostgreSQL Serverless v2
    // =========================================================================
    const dbCluster = new rds.DatabaseCluster(this, 'SuperAgentDB', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 4,
      writer: rds.ClusterInstance.serverlessV2('Writer'),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [dbSg],
      defaultDatabaseName: 'super_agent',
      credentials: rds.Credentials.fromGeneratedSecret('superagent', {
        secretName: 'super-agent/db-credentials',
      }),
      storageEncrypted: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    // =========================================================================
    // IAM Role for EC2
    // =========================================================================
    const role = new iam.Role(this, 'SuperAgentEC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Bedrock access
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: ['*'],
    }));

    // S3 access
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:*'],
      resources: ['arn:aws:s3:::super-agent-*', 'arn:aws:s3:::super-agent-*/*'],
    }));

    // Secrets Manager access (for DB credentials)
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:GetSecretValue',
        'secretsmanager:DescribeSecret',
      ],
      resources: [
        dbCluster.secret!.secretArn,
        `${dbCluster.secret!.secretArn}*`,
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:super-agent/db-credentials*`,
      ],
    }));

    // Cognito admin access (for updating callback URLs via post-deploy script)
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:UpdateUserPoolClient',
        'cognito-idp:DescribeUserPoolClient',
      ],
      resources: [userPool.userPoolArn],
    }));

    // CloudWatch Logs access (for application log streaming)
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogStreams',
      ],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/super-agent/*`],
    }));

    // =========================================================================
    // S3 Bucket for avatars
    // =========================================================================
    const avatarBucket = new s3.Bucket(this, 'AvatarBucket', {
      bucketName: `super-agent-avatars-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });
    avatarBucket.grantReadWrite(role);

    // =========================================================================
    // EC2 Instance — M6g.large (ARM64 Graviton), 100GB GP3
    // =========================================================================
    const userData = ec2.UserData.forLinux();
    const userDataScript = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'user-data.sh'),
      'utf-8',
    );
    userData.addCommands(userDataScript);

    const instance = new ec2.Instance(this, 'SuperAgentInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6G, ec2.InstanceSize.LARGE),
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/canonical/ubuntu/server/22.04/stable/current/arm64/hvm/ebs-gp2/ami-id',
      ),
      securityGroup: ec2Sg,
      role,
      keyPair: ec2.KeyPair.fromKeyPairName(this, 'KeyPair', keyPairName.valueAsString),
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(100, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            iops: 3000,
            encrypted: true,
          }),
        },
      ],
      userData,
    });

    // =========================================================================
    // Elastic IP
    // =========================================================================
    const eip = new ec2.CfnEIP(this, 'SuperAgentEIP');
    new ec2.CfnEIPAssociation(this, 'EIPAssoc', {
      allocationId: eip.attrAllocationId,
      instanceId: instance.instanceId,
    });

    // =========================================================================
    // Cognito domain full URL (for outputs)
    // =========================================================================
    const cognitoDomainFull = `${cognitoDomainPrefix.valueAsString}.auth.${this.region}.amazoncognito.com`;

    // =========================================================================
    // Outputs
    // =========================================================================

    // --- Infrastructure ---
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new cdk.CfnOutput(this, 'PublicIP', { value: eip.attrPublicIp });
    new cdk.CfnOutput(this, 'SSHCommand', {
      value: `ssh -i ${keyPairName.valueAsString}.pem ubuntu@${eip.attrPublicIp}`,
    });
    new cdk.CfnOutput(this, 'AppURL', { value: `http://${eip.attrPublicIp}` });

    // --- Database ---
    new cdk.CfnOutput(this, 'AuroraEndpoint', {
      value: dbCluster.clusterEndpoint.hostname,
      description: 'Aurora PostgreSQL writer endpoint',
    });
    new cdk.CfnOutput(this, 'DBSecretArn', {
      value: dbCluster.secret!.secretArn,
      description: 'Secrets Manager ARN for DB credentials',
    });

    // --- S3 ---
    new cdk.CfnOutput(this, 'AvatarBucketName', { value: avatarBucket.bucketName });

    // --- Cognito (copy these into .env files) ---
    new cdk.CfnOutput(this, 'CognitoUserPoolId', {
      value: userPool.userPoolId,
      description: 'COGNITO_USER_POOL_ID / VITE_COGNITO_USER_POOL_ID',
    });
    new cdk.CfnOutput(this, 'CognitoClientId', {
      value: appClient.userPoolClientId,
      description: 'COGNITO_CLIENT_ID / VITE_COGNITO_CLIENT_ID',
    });
    new cdk.CfnOutput(this, 'CognitoDomainUrl', {
      value: cognitoDomainFull,
      description: 'COGNITO_DOMAIN / VITE_COGNITO_DOMAIN',
    });
    new cdk.CfnOutput(this, 'CognitoRegion', {
      value: this.region,
      description: 'COGNITO_REGION / VITE_COGNITO_REGION',
    });

    // --- Post-deploy helper: update Cognito callback URLs with the real IP ---
    new cdk.CfnOutput(this, 'UpdateCognitoCallbackCommand', {
      value: [
        `aws cognito-idp update-user-pool-client`,
        `--user-pool-id ${userPool.userPoolId}`,
        `--client-id ${appClient.userPoolClientId}`,
        `--callback-urls "http://${eip.attrPublicIp}/auth/callback" "http://localhost:5173/auth/callback"`,
        `--logout-urls "http://${eip.attrPublicIp}/login" "http://localhost:5173/login"`,
        `--allowed-o-auth-flows code`,
        `--allowed-o-auth-scopes openid email profile`,
        `--allowed-o-auth-flows-user-pool-client`,
        `--supported-identity-providers COGNITO`,
        `--region ${this.region}`,
      ].join(' '),
      description: 'Run this after deploy to set Cognito callback URLs to the Elastic IP',
    });
  }
}
