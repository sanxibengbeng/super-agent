#!/bin/bash
REGION=ap-southeast-1
VPC_ID=vpc-0e8fbf1612f70a005

echo "Deleting orphaned VPC resources..."

# Delete NAT Gateways
echo "Deleting NAT Gateways..."
NATGWS=$(aws ec2 describe-nat-gateways --region $REGION --filter "Name=vpc-id,Values=$VPC_ID" "Name=state,Values=available" --query 'NatGateways[].NatGatewayId' --output text)
for ngw in $NATGWS; do
  echo "  Deleting NAT Gateway $ngw..."
  aws ec2 delete-nat-gateway --nat-gateway-id $ngw --region $REGION
done

# Wait for NAT Gateways to be deleted
if [ -n "$NATGWS" ]; then
  echo "Waiting for NAT Gateways to be deleted..."
  sleep 60
fi

# Delete VPC Endpoints
echo "Deleting VPC Endpoints..."
ENDPOINTS=$(aws ec2 describe-vpc-endpoints --region $REGION --filters "Name=vpc-id,Values=$VPC_ID" --query 'VpcEndpoints[].VpcEndpointId' --output text)
if [ -n "$ENDPOINTS" ]; then
  aws ec2 delete-vpc-endpoints --vpc-endpoint-ids $ENDPOINTS --region $REGION
fi

# Delete subnets
echo "Deleting subnets..."
SUBNETS=$(aws ec2 describe-subnets --region $REGION --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[].SubnetId' --output text)
for subnet in $SUBNETS; do
  aws ec2 delete-subnet --subnet-id $subnet --region $REGION 2>&1 || true
done

# Delete route tables (non-main)
echo "Deleting route tables..."
RTS=$(aws ec2 describe-route-tables --region $REGION --filters "Name=vpc-id,Values=$VPC_ID" --query 'RouteTables[?Associations[0].Main!=`true`].RouteTableId' --output text)
for rt in $RTS; do
  # Disassociate first
  ASSOCS=$(aws ec2 describe-route-tables --region $REGION --route-table-ids $rt --query 'RouteTables[0].Associations[?!Main].RouteTableAssociationId' --output text)
  for assoc in $ASSOCS; do
    aws ec2 disassociate-route-table --association-id $assoc --region $REGION 2>&1 || true
  done
  aws ec2 delete-route-table --route-table-id $rt --region $REGION 2>&1 || true
done

# Detach and delete internet gateway
echo "Detaching Internet Gateway..."
IGWS=$(aws ec2 describe-internet-gateways --region $REGION --filters "Name=attachment.vpc-id,Values=$VPC_ID" --query 'InternetGateways[].InternetGatewayId' --output text)
for igw in $IGWS; do
  aws ec2 detach-internet-gateway --internet-gateway-id $igw --vpc-id $VPC_ID --region $REGION 2>&1 || true
  aws ec2 delete-internet-gateway --internet-gateway-id $igw --region $REGION 2>&1 || true
done

# Delete security groups (non-default)
echo "Deleting security groups..."
SGS=$(aws ec2 describe-security-groups --region $REGION --filters "Name=vpc-id,Values=$VPC_ID" --query 'SecurityGroups[?GroupName!=`default`].GroupId' --output text)
for sg in $SGS; do
  aws ec2 delete-security-group --group-id $sg --region $REGION 2>&1 || true
done

# Release EIPs
echo "Checking EIPs..."
EIPS=$(aws ec2 describe-addresses --region $REGION --query 'Addresses[?!AssociationId].AllocationId' --output text)
for eip in $EIPS; do
  aws ec2 release-address --allocation-id $eip --region $REGION 2>&1 || true
done

# Delete VPC
echo "Deleting VPC..."
aws ec2 delete-vpc --vpc-id $VPC_ID --region $REGION 2>&1 || echo "VPC deletion may need retry after NAT GW cleanup"

# Delete orphaned log group
echo "Deleting orphaned log group..."
aws logs delete-log-group --log-group-name /super-agent/dev/ecs --region $REGION 2>&1 || true

# Delete the VPC flow log group
aws logs delete-log-group --log-group-name /aws/vpc/flowlogs --region $REGION 2>&1 || true

echo "Cleanup done."
