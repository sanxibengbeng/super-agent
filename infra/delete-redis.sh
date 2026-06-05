#!/bin/bash
aws elasticache delete-replication-group --replication-group-id sud1xaxk2h4kton1 --no-retain-primary-cluster --region ap-southeast-1 2>&1
