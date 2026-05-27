import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface SecretsProps {
  dbSecretArn: string;
}

export class SecretsConstruct extends Construct {
  public readonly appSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: SecretsProps) {
    super(scope, id);

    // Create application configuration secret
    this.appSecret = new secretsmanager.Secret(this, 'AppSecret', {
      secretName: 'super-agent/app-config',
      description: 'Application configuration secrets for Super Agent',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          ANTHROPIC_API_KEY: '',
          LANGFUSE_SECRET_KEY: '',
          LANGFUSE_PUBLIC_KEY: '',
        }),
        generateStringKey: 'JWT_SECRET',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Output
    new cdk.CfnOutput(this, 'AppSecretArn', {
      value: this.appSecret.secretArn,
      description: 'Application configuration secret ARN',
    });

    new cdk.CfnOutput(this, 'DatabaseSecretReference', {
      value: props.dbSecretArn,
      description: 'Database secret ARN (for reference)',
    });
  }
}
