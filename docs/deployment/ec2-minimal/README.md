# EC2 手动部署方案

在单台 EC2 (m7g.medium, Graviton3) 上手动部署 Super Agent 全栈。

本文档的每一步都是手动 CLI 操作，不依赖 CDK 或自动化脚本。适合需要完全控制部署过程或学习架构的场景。

## 架构图

详细架构图：[architecture.drawio](architecture.drawio)（用 [draw.io](https://app.diagrams.net/) 或 VS Code Draw.io 插件打开）

## 架构概览

```
                    ┌─────────────────┐
                    │   开发者本机     │
                    │  (aws ssm cli)  │
                    └────────┬────────┘
                             │ SSM Session Manager
                             │ (SSH / 端口转发)
                             ▼
┌──────────────────────────────────────────────────────────────┐
│              EC2 Instance (m7g.medium, Graviton3)             │
│                                                              │
│  ┌─────────────────┐  ┌───────────────────────────────────┐ │
│  │  Nginx (systemd) │  │  Backend (systemd)                │ │
│  │  :80 → 301 HTTPS │  │  node dist/index.js :3000         │ │
│  │  :443 自签名证书  │──│  EnvironmentFile: /opt/.env       │ │
│  │  /api/* → :3000  │  └───────────────────────────────────┘ │
│  │  /ws/*  → :3000  │  ┌───────────────────────────────────┐ │
│  │  /*     → dist/  │  │  CloudWatch Agent (systemd)       │ │
│  └─────────────────┘  │  → /super-agent/backend            │ │
│  ┌─────────────────┐  │  → /super-agent/nginx-*            │ │
│  │ Redis 7 (systemd)│  └───────────────────────────────────┘ │
│  │ :6379 (本地)     │                                        │
│  └─────────────────┘                                        │
└──────────────────────────────────────────────────────────────┘
          │                         │
          ▼                         ▼
┌────────────────┐  ┌──────────────────────────────────────────┐
│ RDS PostgreSQL │  │            AWS Services                   │
│ 16.6 t4g.micro │  │  S3 (Workspace, Skills, Avatars)         │
│ Secrets Manager│  │  ECR → AgentCore Runtime (Bedrock)       │
│ 仅 EC2 SG 可连 │  │  SSM, CloudWatch, Secrets Manager       │
└────────────────┘  └──────────────────────────────────────────┘
```

## 前置条件

- AWS CLI v2 + 已配置 credentials（`aws sts get-caller-identity` 能正常返回）
- [Session Manager Plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
- 本地已安装 Node.js 22+（编译后端和前端用）

## AWS 资源清单

| 资源类型 | 名称/用途 |
|---------|----------|
| EC2 Instance | m7g.medium, Ubuntu 22.04 ARM64, 30GB gp3 |
| Elastic IP | 固定公网 IP |
| Security Group × 2 | EC2 (80/443 入站) + RDS (5432 仅 EC2 可连) |
| RDS PostgreSQL | 16.6, db.t4g.micro, Secrets Manager 管理密码 |
| S3 Bucket × 3 | Workspace、Skills、Avatars |
| IAM Role (EC2) | SSM + Bedrock + S3 + SecretsManager + ECR + Logs |
| IAM Role (AgentCore) | Bedrock + S3 + ECR + Logs |
| ECR Repository | AgentCore 容器镜像仓库 |

## 费用预估

| 资源 | 规格 | 预估费用 |
|------|------|---------|
| EC2 | m7g.medium (1 vCPU, 4GB RAM, Graviton3) | ~$30/月 |
| RDS PostgreSQL | db.t4g.micro, 20GB gp3 | ~$15/月 |
| EBS | 30GB gp3 | ~$3/月 |
| S3 + ECR | 存储 + 镜像 | ~$2-5/月 |
| Elastic IP | 绑定运行实例时免费 | $0 |
| **总计（不含 Bedrock 调用）** | | **~$50-53/月** |

Bedrock 按调用量另计。

## 本目录文件

| 文件 | 说明 |
|------|------|
| [README.md](README.md) | 本文档 |
| [architecture.drawio](architecture.drawio) | 架构图 |
| [ec2-trust-policy.json](ec2-trust-policy.json) | EC2 角色信任策略 |
| [ec2-role-policy.json](ec2-role-policy.json) | EC2 角色权限策略 |
| [agentcore-trust-policy.json](agentcore-trust-policy.json) | AgentCore 角色信任策略 |
| [agentcore-role-policy.json](agentcore-role-policy.json) | AgentCore 角色权限策略 |
| [user-ssm-policy.json](user-ssm-policy.json) | 开发者 SSM 连接权限 |

---

## 部署步骤

### 1. 创建 ECR 仓库

```bash
aws ecr create-repository \
  --repository-name super-agent-agentcore \
  --region us-east-1 \
  --image-scanning-configuration scanOnPush=true
```

### 2. 创建 S3 Bucket

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1

aws s3 mb s3://super-agent-workspace-${ACCOUNT_ID} --region $REGION
aws s3 mb s3://super-agent-skills-${ACCOUNT_ID} --region $REGION
aws s3 mb s3://super-agent-avatars-${ACCOUNT_ID} --region $REGION
```

### 3. 创建 EC2 IAM Role

```bash
cd docs/deployment/ec2-minimal

# 替换策略文件中的占位符
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
sed -i "s/YOUR-WORKSPACE-BUCKET/super-agent-workspace-${ACCOUNT_ID}/g" ec2-role-policy.json
sed -i "s/YOUR-SKILLS-BUCKET/super-agent-skills-${ACCOUNT_ID}/g" ec2-role-policy.json
sed -i "s/YOUR-AVATARS-BUCKET/super-agent-avatars-${ACCOUNT_ID}/g" ec2-role-policy.json

# 创建角色
aws iam create-role \
  --role-name SuperAgentEC2Role \
  --assume-role-policy-document file://ec2-trust-policy.json

# 附加自定义权限策略
aws iam put-role-policy \
  --role-name SuperAgentEC2Role \
  --policy-name SuperAgentPolicy \
  --policy-document file://ec2-role-policy.json

# 附加 SSM 托管策略
aws iam attach-role-policy \
  --role-name SuperAgentEC2Role \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

# 创建实例配置文件
aws iam create-instance-profile --instance-profile-name SuperAgentProfile
aws iam add-role-to-instance-profile \
  --instance-profile-name SuperAgentProfile \
  --role-name SuperAgentEC2Role
```

### 4. 创建 AgentCore Execution Role

```bash
# 替换 AgentCore 策略中的占位符
sed -i "s/YOUR-WORKSPACE-BUCKET/super-agent-workspace-${ACCOUNT_ID}/g" agentcore-role-policy.json

aws iam create-role \
  --role-name SuperAgentAgentCoreRole \
  --assume-role-policy-document file://agentcore-trust-policy.json

aws iam put-role-policy \
  --role-name SuperAgentAgentCoreRole \
  --policy-name AgentCorePolicy \
  --policy-document file://agentcore-role-policy.json
```

### 5. 创建安全组

```bash
# 获取默认 VPC ID
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

# EC2 安全组
EC2_SG=$(aws ec2 create-security-group \
  --group-name super-agent-ec2-sg \
  --description "Super Agent EC2 - HTTP/HTTPS" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $EC2_SG --protocol tcp --port 80 --cidr YOUR-IP/32

aws ec2 authorize-security-group-ingress \
  --group-id $EC2_SG --protocol tcp --port 443 --cidr YOUR-IP/32

# RDS 安全组（仅允许 EC2 SG 访问 5432）
DB_SG=$(aws ec2 create-security-group \
  --group-name super-agent-db-sg \
  --description "Super Agent RDS - EC2 only" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $DB_SG --protocol tcp --port 5432 \
  --source-group $EC2_SG
```

> **安全建议：** 将 `YOUR-IP/32` 替换为你的实际 IP。如需零开放端口，可跳过 EC2 SG 入站规则，完全通过 SSM 端口转发访问。

### 6. 创建 RDS PostgreSQL

```bash
# 获取默认 VPC 子网
SUBNET_IDS=$(aws ec2 describe-subnets \
  --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[*].SubnetId' --output text | tr '\t' ',')

# 创建子网组
aws rds create-db-subnet-group \
  --db-subnet-group-name super-agent-db-subnets \
  --db-subnet-group-description "Super Agent RDS subnets" \
  --subnet-ids $(echo $SUBNET_IDS | tr ',' ' ')

# 创建数据库（密码由 Secrets Manager 自动管理）
aws rds create-db-instance \
  --db-instance-identifier super-agent-db \
  --engine postgres --engine-version 16.6 \
  --db-instance-class db.t4g.micro \
  --allocated-storage 20 --max-allocated-storage 50 \
  --storage-type gp3 --storage-encrypted \
  --master-username superagent --manage-master-user-password \
  --db-name super_agent \
  --db-subnet-group-name super-agent-db-subnets \
  --vpc-security-group-ids $DB_SG \
  --no-publicly-accessible \
  --backup-retention-period 7

# 等待创建完成（约 5-10 分钟）
aws rds wait db-instance-available --db-instance-identifier super-agent-db

# 获取连接信息
DB_ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier super-agent-db \
  --query 'DBInstances[0].Endpoint.Address' --output text)

DB_SECRET_ARN=$(aws rds describe-db-instances \
  --db-instance-identifier super-agent-db \
  --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)

echo "DB Endpoint: $DB_ENDPOINT"
echo "DB Secret ARN: $DB_SECRET_ARN"
```

### 7. 启动 EC2 实例

```bash
# 选择一个子网
SUBNET_ID=$(aws ec2 describe-subnets \
  --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[0].SubnetId' --output text)

# 获取最新 Ubuntu 22.04 ARM64 AMI
AMI_ID=$(aws ssm get-parameters \
  --names /aws/service/canonical/ubuntu/server/22.04/stable/current/arm64/hvm/ebs-gp2/ami-id \
  --query 'Parameters[0].Value' --output text)

# 启动实例（user-data 自动安装所有依赖）
INSTANCE_ID=$(aws ec2 run-instances \
  --image-id $AMI_ID \
  --instance-type m7g.medium \
  --iam-instance-profile Name=SuperAgentProfile \
  --security-group-ids $EC2_SG \
  --subnet-id $SUBNET_ID \
  --key-name YOUR-KEY-PAIR \
  --user-data file://../../infra/scripts/user-data.sh \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":30,"VolumeType":"gp3"}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=super-agent}]' \
  --query 'Instances[0].InstanceId' --output text)

echo "Instance ID: $INSTANCE_ID"

# 分配 Elastic IP
ALLOC_ID=$(aws ec2 allocate-address --query 'AllocationId' --output text)
aws ec2 associate-address --instance-id $INSTANCE_ID --allocation-id $ALLOC_ID
PUBLIC_IP=$(aws ec2 describe-addresses --allocation-ids $ALLOC_ID \
  --query 'Addresses[0].PublicIp' --output text)

echo "Public IP: $PUBLIC_IP"
```

`user-data.sh` 会在首次启动时自动安装：

| 组件 | 用途 |
|------|------|
| Node.js 22 | 后端运行时 |
| Nginx + 自签名证书 | 反向代理（80 重定向 HTTPS、443 → 静态文件 + API） |
| Redis 7 | 本地缓存 + BullMQ 队列 |
| CloudWatch Agent | 日志采集到 CloudWatch |
| Claude Code CLI | Agent 运行时依赖 |
| PostgreSQL Client 16 | 数据库迁移和诊断 |
| LibreOffice (headless) | 文档转换 (pptx/docx/xlsx → PDF) |
| AWS CLI v2 | AWS 操作 |

### 8. 等待实例就绪并连接

```bash
# 等待 SSM Agent 在线（user-data 执行完成后才可用，约 3-5 分钟）
for i in $(seq 1 30); do
  STATUS=$(aws ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query "InstanceInformationList[0].PingStatus" --output text 2>/dev/null)
  [ "$STATUS" = "Online" ] && echo "SSM agent online." && break
  echo "Attempt $i/30 - status: $STATUS, waiting 10s..."
  sleep 10
done

# 连接到实例
aws ssm start-session --target $INSTANCE_ID
```

### 9. 配置环境变量

在 EC2 上操作：

```bash
# 获取 DATABASE_URL（使用 user-data 安装的辅助脚本）
DATABASE_URL=$(/opt/super-agent/fetch-db-url.sh YOUR-DB-SECRET-ARN)

# 编辑 .env（user-data 已创建了占位文件）
cat > /opt/super-agent/.env << EOF
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info

DATABASE_URL=${DATABASE_URL}
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=super-agent-redis-password

AUTH_MODE=local
JWT_SECRET=$(openssl rand -hex 32)

AWS_REGION=us-east-1
S3_BUCKET_NAME=super-agent-avatars-YOUR-ACCOUNT-ID
SKILLS_S3_BUCKET=super-agent-skills-YOUR-ACCOUNT-ID
S3_PRESIGNED_URL_EXPIRES=3600

CORS_ORIGIN=https://${PUBLIC_IP}
APP_URL=https://${PUBLIC_IP}

CLAUDE_CODE_USE_BEDROCK=1
CLAUDE_MODEL=claude-sonnet-4-6
AGENT_WORKSPACE_BASE_DIR=/opt/super-agent/workspaces

# Agent Runtime: 'claude'(本地 SDK) 或 'agentcore'
AGENT_RUNTIME=claude

# AgentCore 配置（AGENT_RUNTIME=agentcore 时必填）
# AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:us-east-1:YOUR-ACCOUNT:runtime/YOUR-RUNTIME-ID
# AGENTCORE_EXECUTION_ROLE_ARN=arn:aws:iam::YOUR-ACCOUNT:role/SuperAgentAgentCoreRole
# AGENTCORE_WORKSPACE_S3_BUCKET=super-agent-workspace-YOUR-ACCOUNT-ID
# AGENTCORE_BACKEND_API_URL=https://YOUR-EC2-IP
EOF

chmod 600 /opt/super-agent/.env
```

### 10. 部署应用代码

在**本地开发机**上操作：

```bash
# 配置 SSH over SSM
cat >> ~/.ssh/config << EOF
Host super-agent
  HostName $INSTANCE_ID
  User ubuntu
  ProxyCommand aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p'
EOF

# 编译后端
cd backend && npx tsc --noUnusedLocals false --noUnusedParameters false

# 同步后端到 EC2（排除 node_modules 和 .env）
cd ..
rsync -avz --delete \
  --exclude='node_modules' --exclude='.env' \
  backend/ super-agent:/opt/super-agent/backend/

# 构建前端
cd frontend && npm ci && npx vite build

# 同步前端到 EC2
cd ..
rsync -avz --delete \
  frontend/dist/ super-agent:/opt/super-agent/frontend/dist/
```

### 11. 安装依赖、迁移、启动

SSH 到 EC2 上操作：

```bash
aws ssm start-session --target $INSTANCE_ID
```

```bash
cd /opt/super-agent/backend

# 链接 .env
ln -sf /opt/super-agent/.env .env

# 安装依赖
npm ci --production=false

# 生成 Prisma Client
npx prisma generate

# 运行数据库迁移
npx prisma migrate deploy

# 数据库授权（RDS 默认用户可能需要额外权限）
source /opt/super-agent/.env
psql "$DATABASE_URL" << 'SQL'
GRANT ALL PRIVILEGES ON DATABASE super_agent TO superagent;
GRANT ALL ON SCHEMA public TO superagent;
ALTER SCHEMA public OWNER TO superagent;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO superagent;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO superagent;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO superagent;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO superagent;
SQL

# Seed 初始数据（可选）
npx tsx prisma/seed.ts

# 启动后端服务
sudo systemctl restart backend
sudo systemctl enable backend

# 验证
sleep 3
sudo systemctl status backend
curl -s http://127.0.0.1:3000/health
```

### 12. 验证部署

```bash
# 在 EC2 上
curl -k https://localhost/api/health

# 在本地（直接访问，需安全组已开放）
curl -k https://$PUBLIC_IP/api/health

# 或通过 SSM 端口转发（安全组无需开放）
aws ssm start-session \
  --target $INSTANCE_ID \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["443"],"localPortNumber":["8443"]}'
# 另开终端访问 https://localhost:8443（自签名证书，需接受警告）
```

---

## AgentCore 容器镜像

如果 `AGENT_RUNTIME=agentcore`，需要构建和推送 AgentCore 容器镜像。

### 构建与推送

```bash
cd agentcore
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URI="${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/super-agent-agentcore"

# ECR 登录
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin \
    "${ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com"

# 构建（必须 ARM64 + 禁用 BuildKit）
DOCKER_BUILDKIT=0 docker build --platform linux/arm64 -t ${ECR_URI}:latest .

# 推送
docker push ${ECR_URI}:latest
```

**重要：**
- **必须 `DOCKER_BUILDKIT=0`** — BuildKit 会在 manifest 中添加 unknown/unknown 架构条目，导致 AgentCore microVM 启动失败
- **必须 ARM64** — 在 ARM 主机上原生构建，不要交叉编译为 amd64

### 创建 AgentCore Runtime

1. AWS Console → Bedrock → AgentCore → Create Runtime
2. 指定 ECR 镜像 URI（上一步推送的地址）
3. 设置执行角色 ARN：`SuperAgentAgentCoreRole`
4. 记录 Runtime ARN
5. 将 ARN 填入 EC2 上的 `/opt/super-agent/.env`，取消注释 `AGENTCORE_*` 相关变量
6. 重启后端：`sudo systemctl restart backend`

---

## IAM 权限详解

### EC2 实例角色 (SuperAgentEC2Role)

- 信任策略：[ec2-trust-policy.json](ec2-trust-policy.json)
- 权限策略：[ec2-role-policy.json](ec2-role-policy.json) + `AmazonSSMManagedInstanceCore` 托管策略

| 权限 | 用途 |
|------|------|
| `AmazonSSMManagedInstanceCore` (托管策略) | SSM Session Manager 连接 |
| `bedrock:InvokeModel*` | 直接调用 Bedrock 模型 |
| `bedrock-agentcore:InvokeAgentRuntime` | 调用 AgentCore Runtime |
| `s3:Get/Put/Delete/List` | Workspace、Skills、Avatar 文件操作 |
| `secretsmanager:GetSecretValue/DescribeSecret` | 读取 RDS 数据库密码 |
| `ecr:*` (Pull + Push) | 拉取/推送 AgentCore 容器镜像 |
| `logs:CreateLogGroup/PutLogEvents/...` | CloudWatch 日志 |

### AgentCore 执行角色 (SuperAgentAgentCoreRole)

- 信任策略：[agentcore-trust-policy.json](agentcore-trust-policy.json)
- 权限策略：[agentcore-role-policy.json](agentcore-role-policy.json)

| 权限 | 用途 |
|------|------|
| `bedrock:InvokeModel*` | Claude 模型调用 |
| `s3:Get/Put/Delete/List` | Workspace 文件同步 |
| `ecr:BatchGetImage/...` | 拉取容器镜像 |
| `logs:*` | CloudWatch 日志 |

---

## 安全组配置

| 安全组 | 入站规则 | 出站规则 | 用途 |
|--------|---------|---------|------|
| EC2 SG | TCP 80, 443（限制来源 IP） | 全部放行 | Nginx HTTPS + HTTP 重定向 |
| RDS SG | TCP 5432（仅 EC2 SG） | 无 | PostgreSQL |

> **零开放端口方案：** 不添加 EC2 SG 的入站规则，通过 SSM 端口转发访问 443 端口。

---

## SSM Session Manager 连接

### 开发者权限

IAM 用户/组需附加 SSM 权限：[user-ssm-policy.json](user-ssm-policy.json)

```bash
aws iam put-user-policy \
  --user-name YOUR-USERNAME \
  --policy-name SSMAccess \
  --policy-document file://user-ssm-policy.json
```

### 安装 Session Manager Plugin

```bash
# macOS
brew install awscli session-manager-plugin

# Linux (x86_64)
curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" \
  -o "session-manager-plugin.deb"
sudo dpkg -i session-manager-plugin.deb
```

### 连接方式

```bash
# 直接 Shell
aws ssm start-session --target i-xxxxxxxxx

# 端口转发
aws ssm start-session \
  --target i-xxxxxxxxx \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["443"],"localPortNumber":["8443"]}'

# SSH over SSM（需配置 ~/.ssh/config，见步骤 10）
ssh super-agent
```

---

## EC2 目录结构

```
/opt/super-agent/
├── .env                        # 环境变量
├── fetch-db-url.sh             # RDS 密码获取脚本（user-data 创建）
├── logs/
│   ├── backend.log             # 后端标准输出
│   └── backend-error.log       # 后端错误日志
├── backend/
│   ├── dist/                   # 编译后的 JS
│   ├── node_modules/
│   ├── prisma/                 # Schema + 迁移
│   └── .env → /opt/super-agent/.env
├── frontend/
│   └── dist/                   # Vite 构建产物
└── workspaces/                 # Agent 工作目录
```

---

## 日常运维

### 服务管理

```bash
# 后端
sudo systemctl status backend
sudo systemctl restart backend
tail -f /opt/super-agent/logs/backend.log
tail -f /opt/super-agent/logs/backend-error.log

# Nginx
sudo systemctl status nginx
sudo nginx -t && sudo systemctl reload nginx
tail -f /var/log/nginx/error.log

# Redis
sudo systemctl status redis-server
redis-cli -a super-agent-redis-password ping
```

### CloudWatch 日志组

| 日志组 | 来源 | 保留天数 |
|--------|------|---------|
| `/super-agent/backend` | 后端标准输出 | 30 |
| `/super-agent/backend-errors` | 后端错误 | 30 |
| `/super-agent/nginx-access` | Nginx 访问日志 | 14 |
| `/super-agent/nginx-errors` | Nginx 错误日志 | 14 |

### 数据库备份

```bash
source /opt/super-agent/.env
pg_dump "$DATABASE_URL" > backup-$(date +%Y%m%d).sql

# 恢复
psql "$DATABASE_URL" < backup-20260423.sql
```

RDS 自身配置了 7 天自动备份。

### 更新部署

在本地开发机上重复步骤 10-11：

```bash
# 编译 + 同步后端
cd backend && npx tsc --noUnusedLocals false --noUnusedParameters false
cd .. && rsync -avz --delete --exclude='node_modules' --exclude='.env' \
  backend/ super-agent:/opt/super-agent/backend/

# 构建 + 同步前端
cd frontend && npx vite build
cd .. && rsync -avz --delete frontend/dist/ super-agent:/opt/super-agent/frontend/dist/

# EC2 上安装依赖、迁移、重启
ssh super-agent << 'EOF'
cd /opt/super-agent/backend
npm ci --production=false
npx prisma generate
npx prisma migrate deploy
sudo systemctl restart backend
EOF
```

---

## 故障排查

### 后端无法启动

```bash
sudo systemctl status backend
tail -50 /opt/super-agent/logs/backend-error.log

# 手动启动定位问题
cd /opt/super-agent/backend
source /opt/super-agent/.env
node dist/index.js
```

### 数据库连接失败

```bash
source /opt/super-agent/.env
psql "$DATABASE_URL" -c "SELECT 1"

# 密码可能已轮转，重新获取
/opt/super-agent/fetch-db-url.sh YOUR-DB-SECRET-ARN
# 将输出更新到 .env 的 DATABASE_URL
```

### AgentCore 调用失败

```bash
source /opt/super-agent/.env
echo "RUNTIME_ARN: $AGENTCORE_RUNTIME_ARN"
echo "ROLE_ARN: $AGENTCORE_EXECUTION_ROLE_ARN"
echo "S3_BUCKET: $AGENTCORE_WORKSPACE_S3_BUCKET"

# 检查 IAM
aws sts get-caller-identity
aws s3 ls s3://$AGENTCORE_WORKSPACE_S3_BUCKET/
```

### Nginx 502 Bad Gateway

```bash
curl http://127.0.0.1:3000/health      # 后端是否运行
sudo nginx -t                            # 配置是否正确
tail -20 /var/log/nginx/error.log
```

---

## 扩展方案

| 场景 | 升级路径 |
|------|---------|
| CPU/内存不足 | m7g.medium → m7g.large → m7g.xlarge |
| 数据库压力大 | db.t4g.micro → db.t4g.small → db.r7g.large |
| Redis 需要托管 | 本地 Redis → ElastiCache Redis (cache.t4g.micro) |
| 自定义域名 + CDN | 添加 CloudFront + ACM + Route53 |
| SSO 认证 | AUTH_MODE=cognito + Cognito User Pool |
| 高可用 | 多 EC2 + ALB + RDS Multi-AZ |
| 自动化部署 | 使用 `infra/` 目录的 CDK 堆栈 |

## 环境变量参考

| 变量 | 必需 | 说明 |
|------|------|------|
| `DATABASE_URL` | 是 | PostgreSQL 连接字符串 |
| `REDIS_HOST` | 是 | 默认 `localhost` |
| `REDIS_PORT` | 是 | 默认 `6379` |
| `REDIS_PASSWORD` | 是 | user-data 设置的 `super-agent-redis-password` |
| `AUTH_MODE` | 是 | `local` 或 `cognito` |
| `JWT_SECRET` | local 模式 | 认证密钥 |
| `S3_BUCKET_NAME` | 是 | Avatar 桶名 |
| `SKILLS_S3_BUCKET` | 是 | Skills 桶名 |
| `CORS_ORIGIN` | 是 | 允许的前端源 |
| `APP_URL` | 是 | 应用 URL |
| `CLAUDE_CODE_USE_BEDROCK` | 是 | 设为 `1` |
| `CLAUDE_MODEL` | 否 | 默认 `claude-sonnet-4-6` |
| `AGENT_RUNTIME` | 是 | `claude`（本地 SDK）或 `agentcore` |
| `AGENTCORE_RUNTIME_ARN` | agentcore 时 | AgentCore Runtime ARN |
| `AGENTCORE_EXECUTION_ROLE_ARN` | agentcore 时 | 执行角色 ARN |
| `AGENTCORE_WORKSPACE_S3_BUCKET` | agentcore 时 | Workspace S3 桶 |
| `AGENTCORE_BACKEND_API_URL` | agentcore 时 | Backend 回调 URL |
