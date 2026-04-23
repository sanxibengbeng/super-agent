# EC2 最小部署方案

本文档说明如何在单台 EC2 上运行 Super Agent，使用 Docker Compose 运行 PostgreSQL 和 Redis，并连接 AWS Bedrock AgentCore。

## 架构图

详细架构图请参考：[architecture.drawio](architecture.drawio)

可使用 [draw.io](https://app.diagrams.net/) 或 VS Code Draw.io 插件打开查看。

## 架构概览

```
                    ┌─────────────────┐
                    │   开发者本机     │
                    │  (aws ssm cli)  │
                    └────────┬────────┘
                             │ SSM Session Manager
                             │ (端口转发 :8080)
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                   EC2 Instance (无开放端口)                   │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              Docker Compose                              │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐              │ │
│  │  │ Postgres │  │  Redis   │  │ Backend  │              │ │
│  │  │   :5432  │  │  :6379   │  │  :3000   │              │ │
│  │  └──────────┘  └──────────┘  └──────────┘              │ │
│  │  ┌──────────┐  ┌──────────┐                            │ │
│  │  │ Frontend │  │  Nginx   │◄── localhost:8080          │ │
│  │  │  :5173   │  │  :8080   │                            │ │
│  │  └──────────┘  └──────────┘                            │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                              │ 出站 :443 only
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                      AWS Services                             │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐             │
│  │    ECR     │  │  AgentCore │  │     S3     │             │
│  │ (镜像仓库) │  │  (Runtime) │  │(Workspaces)│             │
│  └────────────┘  └────────────┘  └────────────┘             │
│  ┌────────────┐  ┌────────────┐                             │
│  │    SSM     │  │ CloudWatch │                             │
│  │(连接管理)  │  │   (日志)   │                             │
│  └────────────┘  └────────────┘                             │
└──────────────────────────────────────────────────────────────┘
```

## AWS 资源清单

| 资源类型 | 名称/用途 | 必需 |
|---------|----------|------|
| **ECR Repository** | AgentCore 容器镜像仓库 | ✅ |
| **S3 Bucket** | Workspace 文件同步 | ✅ |
| **IAM Role (EC2)** | EC2 实例角色 | ✅ |
| **IAM Role (AgentCore)** | AgentCore 执行角色 | ✅ |
| **AgentCore Runtime** | 托管 Agent 运行时 | ✅ |
| **EC2 Instance** | 运行 Super Agent 应用 | ✅ |
| **Security Group** | 网络访问控制 | ✅ |

## 最小配置要求

| 资源 | 规格 | 预估费用 |
|------|------|---------|
| EC2 实例 | t4g.small (2 vCPU, 2GB RAM) | ~$12/月 |
| EBS 存储 | 30GB gp3 | ~$3/月 |
| S3 Bucket | Workspace 存储 | ~$1-5/月 |
| ECR | 容器镜像存储 | ~$1/月 |
| **总计** | | **~$17-21/月** |

注意：Bedrock 按调用量计费，Claude Sonnet 约 $3/百万输入 token，$15/百万输出 token。

## 本目录文件

| 文件 | 说明 |
|------|------|
| [README.md](README.md) | 本文档 |
| [architecture.drawio](architecture.drawio) | 架构图（AWS 官方图标）|
| [ec2-trust-policy.json](ec2-trust-policy.json) | EC2 角色信任策略 |
| [ec2-role-policy.json](ec2-role-policy.json) | EC2 角色权限策略 |
| [agentcore-trust-policy.json](agentcore-trust-policy.json) | AgentCore 角色信任策略 |
| [agentcore-role-policy.json](agentcore-role-policy.json) | AgentCore 角色权限策略 |
| [user-ssm-policy.json](user-ssm-policy.json) | 开发者 SSM 连接权限 |

## IAM 权限配置

### 1. EC2 实例角色 (SuperAgentEC2Role)

EC2 实例需要以下 IAM 权限：

- 信任策略：[ec2-trust-policy.json](ec2-trust-policy.json)
- 权限策略：[ec2-role-policy.json](ec2-role-policy.json)

**权限清单：**
| 权限 | 用途 |
|------|------|
| `ssm:*`, `ssmmessages:*`, `ec2messages:*` | SSM Session Manager 连接 |
| `bedrock:InvokeModel*` | 直接调用 Bedrock 模型 |
| `bedrock-agentcore:InvokeAgentRuntime` | 调用 AgentCore Runtime |
| `s3:GetObject/PutObject/DeleteObject/ListBucket` | Workspace 文件同步 |
| `ecr:GetAuthorizationToken/BatchGetImage/...` | 拉取/推送容器镜像 |
| `logs:CreateLogGroup/PutLogEvents/...` | CloudWatch 日志 |

### 2. AgentCore 执行角色 (SuperAgentAgentCoreRole)

AgentCore 容器运行时使用独立的 IAM Role：

- 信任策略：[agentcore-trust-policy.json](agentcore-trust-policy.json)
- 权限策略：[agentcore-role-policy.json](agentcore-role-policy.json)

**权限清单：**
| 权限 | 用途 |
|------|------|
| `bedrock:InvokeModel*` | Claude 模型调用 |
| `s3:GetObject/PutObject/DeleteObject/ListBucket` | Workspace 文件同步 |
| `ecr:BatchGetImage/...` | 拉取容器镜像 |
| `logs:*` | CloudWatch 日志 |

**详细策略 (Permission Policy):**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockInvoke",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": "*"
    },
    {
      "Sid": "S3WorkspaceAccess",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::YOUR-WORKSPACE-BUCKET",
        "arn:aws:s3:::YOUR-WORKSPACE-BUCKET/*"
      ]
    },
    {
      "Sid": "ECRPullImage",
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:log-group:/aws/bedrock-agentcore/*"
    }
  ]
}
```

## 关于 AgentCore 和 EMR

**不需要 EMR。** AgentCore 是 AWS Bedrock 的托管服务，完全独立于 EMR：

- AgentCore 运行在 AWS 托管的 micro-VM 中
- 无需管理基础设施
- 按调用计费，无固定费用
- 容器镜像存储在 ECR，由 AgentCore 拉取运行

## 部署步骤

### 1. 创建 ECR 仓库

```bash
# 创建 AgentCore 容器镜像仓库
aws ecr create-repository \
  --repository-name super-agent-agentcore \
  --region us-east-1 \
  --image-scanning-configuration scanOnPush=true
```

### 2. 创建 S3 Bucket

```bash
aws s3 mb s3://super-agent-workspace-YOUR-ACCOUNT-ID --region us-east-1
```

### 3. 创建 IAM Role

使用本目录下的 JSON 策略文件：

```bash
# 进入策略文件目录
cd docs/deployment/ec2-minimal

# 修改策略文件中的 YOUR-WORKSPACE-BUCKET 为实际桶名
sed -i 's/YOUR-WORKSPACE-BUCKET/super-agent-workspace-YOUR-ACCOUNT-ID/g' ec2-role-policy.json
sed -i 's/YOUR-WORKSPACE-BUCKET/super-agent-workspace-YOUR-ACCOUNT-ID/g' agentcore-role-policy.json

# 创建 EC2 角色
aws iam create-role \
  --role-name SuperAgentEC2Role \
  --assume-role-policy-document file://ec2-trust-policy.json

# 附加权限策略
aws iam put-role-policy \
  --role-name SuperAgentEC2Role \
  --policy-name SuperAgentPolicy \
  --policy-document file://ec2-role-policy.json

# 创建实例配置文件
aws iam create-instance-profile --instance-profile-name SuperAgentProfile
aws iam add-role-to-instance-profile \
  --instance-profile-name SuperAgentProfile \
  --role-name SuperAgentEC2Role
```

### 4. 创建 AgentCore Execution Role

```bash
# 创建 AgentCore 执行角色
aws iam create-role \
  --role-name SuperAgentAgentCoreRole \
  --assume-role-policy-document file://agentcore-trust-policy.json

# 附加权限策略
aws iam put-role-policy \
  --role-name SuperAgentAgentCoreRole \
  --policy-name AgentCorePolicy \
  --policy-document file://agentcore-role-policy.json
```

### 6. 启动 EC2 实例

```bash
aws ec2 run-instances \
  --image-id ami-xxxxxxxxx \  # Ubuntu 22.04 ARM64
  --instance-type t4g.small \
  --iam-instance-profile Name=SuperAgentProfile \
  --security-group-ids sg-xxxxxxxxx \
  --subnet-id subnet-xxxxxxxxx \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":30,"VolumeType":"gp3"}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=super-agent}]'
```

### 7. 安装依赖

SSH 进入实例后：

```bash
# 安装 Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu
newgrp docker

# 安装 Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

### 8. 部署应用

```bash
# 克隆代码
git clone https://github.com/your-org/super-agent.git
cd super-agent

# 配置环境变量
cat > docker-compose.override.yml << 'EOF'
services:
  backend:
    environment:
      # 使用 AgentCore Runtime
      AGENT_RUNTIME: agentcore
      CLAUDE_CODE_USE_BEDROCK: "1"
      CLAUDE_MODEL: claude-sonnet-4-6
      
      # AgentCore 配置
      AGENTCORE_RUNTIME_ARN: arn:aws:bedrock-agentcore:us-east-1:YOUR-ACCOUNT:runtime/YOUR-RUNTIME-ID
      AGENTCORE_EXECUTION_ROLE_ARN: arn:aws:iam::YOUR-ACCOUNT:role/SuperAgentAgentCoreRole
      AGENTCORE_WORKSPACE_S3_BUCKET: super-agent-workspace-YOUR-ACCOUNT-ID
      
      # API URL（AgentCore 容器回调）
      AGENTCORE_BACKEND_API_URL: http://YOUR-EC2-PUBLIC-IP:8080
EOF

# 启动服务
docker compose up -d --build

# 运行数据库迁移
docker exec super-agent-backend npx prisma migrate deploy

# 查看日志
docker compose logs -f
```

## AgentCore Runtime 配置

### 创建 AgentCore Runtime

AgentCore Runtime 是通过 AWS Console 或 SDK 创建的：

1. 访问 AWS Console → Bedrock → AgentCore
2. 创建新 Runtime
3. 上传容器镜像（`agentcore/` 目录构建）
4. 配置执行角色（AGENTCORE_EXECUTION_ROLE_ARN）
5. 获取 Runtime ARN

### AgentCore 容器镜像

```bash
# 构建 AgentCore 容器
cd agentcore
docker build -t super-agent-agentcore .

# 推送到 ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin YOUR-ACCOUNT.dkr.ecr.us-east-1.amazonaws.com
docker tag super-agent-agentcore:latest YOUR-ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/super-agent-agentcore:latest
docker push YOUR-ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/super-agent-agentcore:latest
```

## 安全组配置（零开放端口）

本方案不开放任何入站端口，通过 AWS SSM Session Manager 安全访问：

| 规则 | 端口 | 来源 | 用途 |
|------|------|------|------|
| 入站 | 无 | - | 无入站规则 |
| 出站 | 443 | 0.0.0.0/0 | AWS API (SSM, S3, ECR, Bedrock) |

```bash
# 创建安全组（仅出站 443）
aws ec2 create-security-group \
  --group-name super-agent-sg \
  --description "Super Agent - SSM only, no inbound"

# 删除默认入站规则（如有）
aws ec2 revoke-security-group-ingress \
  --group-name super-agent-sg \
  --protocol all \
  --source-group super-agent-sg 2>/dev/null || true

# 确保出站 443 允许（默认已允许所有出站）
```

## SSM Session Manager 连接

### 前置条件

1. 开发者 IAM 用户需要 SSM 连接权限：[user-ssm-policy.json](user-ssm-policy.json)

```bash
# 为 IAM 用户/组附加策略
aws iam put-user-policy \
  --user-name YOUR-USERNAME \
  --policy-name SSMAccess \
  --policy-document file://user-ssm-policy.json
```

2. 安装 AWS CLI v2 和 Session Manager Plugin：
```bash
# macOS
brew install awscli session-manager-plugin

# Linux
curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" -o "session-manager-plugin.deb"
sudo dpkg -i session-manager-plugin.deb
```

3. EC2 实例已安装 SSM Agent（Ubuntu 22.04 默认已安装）

### 连接实例

```bash
# 直接连接 Shell
aws ssm start-session --target i-xxxxxxxxx

# 端口转发（本地访问应用）
aws ssm start-session \
  --target i-xxxxxxxxx \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8080"],"localPortNumber":["8080"]}'

# 然后在本地浏览器访问 http://localhost:8080
```

### SSH over SSM（可选）

如需 SSH 功能（如 SCP、rsync），配置 `~/.ssh/config`：

```
Host super-agent
  HostName i-xxxxxxxxx
  User ubuntu
  ProxyCommand aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p'
```

然后：
```bash
ssh super-agent
scp file.txt super-agent:/home/ubuntu/
```

## 数据持久化

Docker Compose 使用命名卷存储数据：

- `pgdata`: PostgreSQL 数据
- `backend_node_modules`: 后端依赖
- `frontend_node_modules`: 前端依赖

备份建议：

```bash
# 备份数据库
docker exec super-agent-postgres pg_dump -U superagent super_agent > backup.sql

# 恢复
docker exec -i super-agent-postgres psql -U superagent super_agent < backup.sql
```

## 监控和日志

```bash
# 查看所有服务状态
docker compose ps

# 查看实时日志
docker compose logs -f backend
docker compose logs -f nginx

# 查看资源使用
docker stats
```

## 故障排查

### AgentCore 调用失败

1. 检查 IAM 权限：
```bash
aws sts get-caller-identity  # 确认身份
aws bedrock-agentcore invoke-agent-runtime --agent-runtime-arn ARN --payload '{}' --dry-run
```

2. 检查 Runtime ARN 配置：
```bash
docker exec super-agent-backend printenv | grep AGENTCORE
```

### S3 同步失败

1. 检查 Bucket 权限：
```bash
aws s3 ls s3://YOUR-WORKSPACE-BUCKET/
```

2. 检查容器日志：
```bash
docker compose logs backend | grep agentcore-runtime
```

## 扩展方案

当流量增长时，可以：

1. **升级实例**: t4g.small → t4g.medium → t4g.large
2. **分离数据库**: Docker PostgreSQL → RDS Aurora (~$15/月)
3. **分离缓存**: Docker Redis → ElastiCache (~$12/月)
4. **负载均衡**: 多 EC2 + ALB
5. **CDK 完整部署**: 使用 `infra/` 目录的 CDK 堆栈

## 环境变量参考

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `AGENT_RUNTIME` | 是 | `claude` | 设为 `agentcore` |
| `CLAUDE_CODE_USE_BEDROCK` | 是 | `false` | 设为 `1` |
| `CLAUDE_MODEL` | 否 | `claude-sonnet-4-6` | Claude 模型 |
| `AGENTCORE_RUNTIME_ARN` | 是 | - | AgentCore Runtime ARN |
| `AGENTCORE_EXECUTION_ROLE_ARN` | 是 | - | 执行角色 ARN |
| `AGENTCORE_WORKSPACE_S3_BUCKET` | 是 | - | Workspace S3 桶 |
| `AGENTCORE_BACKEND_API_URL` | 是 | - | Backend 回调 URL |
| `AWS_REGION` | 否 | `us-east-1` | AWS 区域 |
