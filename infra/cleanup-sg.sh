#!/bin/bash
set -e
aws cloudformation delete-stack --stack-name SuperAgent-dev --region ap-southeast-1
echo "Delete initiated. Waiting for completion..."
aws cloudformation wait stack-delete-complete --stack-name SuperAgent-dev --region ap-southeast-1
echo "Stack deleted successfully."
