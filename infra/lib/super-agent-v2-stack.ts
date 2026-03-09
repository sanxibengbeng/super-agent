import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SuperAgentV2Stack - Full standalone deployment (no hardcoded account values)
 *
 * Creates all resources from scratch:
 *   - VPC (default), Security Groups, EC2, EIP
 *   - RDS PostgreSQL (single-AZ, db.t4g.micro)
 *   - Cognito User Pool + App Client
 *   - S3 avatar bucket
 *
 * Security:
 *   - No SSH from internet - use SSM Session Manager
 *   - No raw backend port exposed - Nginx proxies on 443
 *   - HTTP/HTTPS restricted to configurable CIDR
 *   - S3 access scoped to specific bucket
 */
export class SuperAgentV2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =========================================================================
    // Parameters
    // =========================================================================
    const keyPairName = new cdk.CfnParameter(this, 'KeyPairName', {
      type: 'String',
      description: 'EC2 Key Pair name for SSH via SSM port-forward',
    });

    const adminEmail = new cdk.CfnParameter(this, 'AdminEmail', {
      type: 'String',
      default: 'admin@example.com',
      description: 'Email for the initial admin user in Cognito',
    });

    const cognitoDomainPrefix = new cdk.CfnParameter(this, 'CognitoDomainPrefix', {
      type: 'String',
      description: 'Cognito Hosted UI domain prefix (must be globally unique)',
    });

    const allowedCidr = new cdk.CfnParameter(this, 'AllowedCidr', {
      type: 'String',
      default: '0.0.0.0/0',
      description: 'CIDR allowed to access HTTP/HTTPS (set to your IP or VPN CIDR for tighter security)',
    });

    // =========================================================================
    // VPC - use the default VPC
    // =========================================================================
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // =========================================================================
    // Security Groups
    // =========================================================================
    const ec2Sg = new ec2.SecurityGroup(this, 'EC2SG', {
      vpc,
      description: 'Super Agent V2 EC2 - hardened',
      allowAllOutbound: true,
    });
    // Only HTTP and HTTPS - no SSH from internet, no raw backend port
    ec2Sg.addIngressRule(
      ec2.Peer.ipv4(allowedCidr.valueAsString),
      ec2.Port.tcp(80),
      'HTTP (redirects to HTTPS)',
    );
    ec2Sg.addIngressRule(
      ec2.Peer.ipv4(allowedCidr.valueAsString),
      ec2.Port.tcp(443),
      'HTTPS',
    );

    const dbSg = new ec2.SecurityGroup(this, 'DBSG', {
      vpc,
      description: 'RDS PostgreSQL',
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
    userPool.addDomain('CognitoDomain', {
      cognitoDomain: {
        domainPrefix: cognitoDomainPrefix.valueAsString,
      },
    });

    // App Client - public client for SPA (PKCE, no secret)
    const appClient = userPool.addClient('SuperAgentAppClient', {
      userPoolClientName: 'super-agent-web',
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: ['http://localhost:5173/auth/callback'],
        logoutUrls: ['http://localhost:5173/login'],
      },
      preventUserExistenceErrors: true,
    });

    // Initial admin user
    new cognito.CfnUserPoolUser(this, 'AdminUser', {
      userPoolId: userPool.userPoolId,
      username: adminEmail.valueAsString,
      userAttributes: [
        { name: 'email', value: adminEmail.valueAsString },
        { name: 'email_verified', value: 'true' },
      ],
      desiredDeliveryMediums: ['EMAIL'],
    });

    // =========================================================================
    // RDS PostgreSQL (single-AZ, db.t4g.micro - ~$12/month)
    // =========================================================================
    const dbInstance = new rds.DatabaseInstance(this, 'SuperAgentDB', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_6,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [dbSg],
      databaseName: 'super_agent',
      credentials: rds.Credentials.fromGeneratedSecret('superagent', {
        secretName: 'super-agent/db-credentials',
      }),
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      backupRetention: cdk.Duration.days(7),
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

    // Secrets Manager access (for DB credentials)
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:GetSecretValue',
        'secretsmanager:DescribeSecret',
      ],
      resources: [
        dbInstance.secret!.secretArn,
        `${dbInstance.secret!.secretArn}*`,
      ],
    }));

    // Cognito admin access (for updating callback URLs via post-deploy)
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:UpdateUserPoolClient',
        'cognito-idp:DescribeUserPoolClient',
      ],
      resources: [userPool.userPoolArn],
    }));

    // CloudWatch Logs access
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
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });
    avatarBucket.grantReadWrite(role);

    // =========================================================================
    // EC2 Instance - t4g.small (ARM64 Graviton), 30GB GP3
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
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/canonical/ubuntu/server/22.04/stable/current/arm64/hvm/ebs-gp2/ami-id',
      ),
      securityGroup: ec2Sg,
      role,
      keyPair: ec2.KeyPair.fromKeyPairName(this, 'KeyPair', keyPairName.valueAsString),
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(30, {
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
    // Cognito domain full URL
    // =========================================================================
    const cognitoDomainFull = `${cognitoDomainPrefix.valueAsString}.auth.${this.region}.amazoncognito.com`;

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new cdk.CfnOutput(this, 'PublicIP', { value: eip.attrPublicIp });
    new cdk.CfnOutput(this, 'AppURL', { value: `https://${eip.attrPublicIp}` });
    new cdk.CfnOutput(this, 'SSMCommand', {
      value: `aws ssm start-session --target ${instance.instanceId} --region ${this.region}`,
      description: 'Use SSM Session Manager instead of SSH',
    });

    new cdk.CfnOutput(this, 'DBEndpoint', {
      value: dbInstance.dbInstanceEndpointAddress,
      description: 'RDS PostgreSQL endpoint',
    });
    new cdk.CfnOutput(this, 'DBSecretArn', {
      value: dbInstance.secret!.secretArn,
      description: 'Secrets Manager ARN for DB credentials',
    });

    new cdk.CfnOutput(this, 'AvatarBucketName', { value: avatarBucket.bucketName });

    new cdk.CfnOutput(this, 'CognitoUserPoolId', {
      value: userPool.userPoolId,
      description: 'COGNITO_USER_POOL_ID',
    });
    new cdk.CfnOutput(this, 'CognitoClientId', {
      value: appClient.userPoolClientId,
      description: 'COGNITO_CLIENT_ID',
    });
    new cdk.CfnOutput(this, 'CognitoDomainUrl', {
      value: cognitoDomainFull,
      description: 'COGNITO_DOMAIN',
    });
    new cdk.CfnOutput(this, 'CognitoRegion', {
      value: this.region,
    });

    new cdk.CfnOutput(this, 'UpdateCognitoCallbackCommand', {
      value: [
        `aws cognito-idp update-user-pool-client`,
        `--user-pool-id ${userPool.userPoolId}`,
        `--client-id ${appClient.userPoolClientId}`,
        `--callback-urls "https://${eip.attrPublicIp}/auth/callback" "http://localhost:5173/auth/callback"`,
        `--logout-urls "https://${eip.attrPublicIp}/login" "http://localhost:5173/login"`,
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
