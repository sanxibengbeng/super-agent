#!/bin/bash
set -e
export CDK_DEFAULT_ACCOUNT=873543029686
export CDK_DEFAULT_REGION=ap-southeast-1
cd /home/ubuntu/super-agent/infra
npx cdk deploy SuperAgent-dev -c region=ap-southeast-1 -c enableAgentCore=false --require-approval never --method=direct 2>&1
