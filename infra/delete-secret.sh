#!/bin/bash
aws secretsmanager delete-secret --secret-id super-agent/app-config --region ap-southeast-1 --force-delete-without-recovery
