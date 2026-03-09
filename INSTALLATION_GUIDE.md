# Super Agent 安装部署指南

本指南将引导你将 Super Agent 平台部署到你自己的 AWS 账号中。部署完成后，你将获得一个运行在 EC2 上的完整平台，包含前端、后端、数据库和认证系统。

---

## 架构概览

部署将创建以下 AWS 资源：

| 资源 | 规格 | 用途 |
| --- | --- | --- |
| EC2 (Graviton) | t4g.small, 30GB GP3 | 运行前端 (Nginx) + 后端 (Node.js) + Redis |
| RDS PostgreSQL | db.t4g.micro, 20GB GP3 | 业务数据库 |
| Cognito User Pool | — | 用户认证 (OAuth 2.0 + PKCE) |
| S3 Bucket | — | 头像和文件存储 |
| Elastic IP | — | 固定公网 IP |
| SSM Session Manager | — | 安全远程访问 (无需开放 SSH 端口) |

预估月费用：约 $25–35 USD（us-west-2 区域，最小规格）。

---

## 前置条件

### 本地环境

- **Node.js** >= 18
- **AWS CLI v2**（已配置凭证，具有 AdministratorAccess 或等效权限）
- **AWS Session Manager Plugin**（用于安全连接 EC2）
  - 安装指南：https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html
- **Git**

### AWS 账号

- 已启用 **Amazon Bedrock** 中的 Claude 模型访问权限（在目标区域的 Bedrock 控制台中申请模型访问）
- 已创建 **EC2 Key Pair**（用于通过 SSM 隧道进行 SSH/rsync）
- 已完成 **CDK Bootstrap**（如果是首次在该账号/区域使用 CDK）

---

## 第一步：克隆仓库

```bash
git clone <repository-url>
cd super-agent
```

---

## 第二步：CDK Bootstrap（仅首次需要）

如果你从未在目标 AWS 账号和区域中使用过 CDK，需要先执行 bootstrap：

```bash
# 确认当前 AWS 身份
aws sts get-caller-identity

# Bootstrap CDK（替换为你的账号 ID 和目标区域）
npx cdk bootstrap aws://<YOUR_ACCOUNT_ID>/us-west-2
```

---

## 第三步：创建 EC2 Key Pair

如果你还没有 Key Pair，在 AWS 控制台或 CLI 中创建一个：

```bash
aws ec2 create-key-pair \
  --key-name super-agent-key \
  --key-type ed25519 \
  --query 'KeyMaterial' \
  --output text \
  --region us-west-2 > ~/super-agent-key.pem

chmod 400 ~/super-agent-key.pem
```

记住 Key Pair 名称（如 `super-agent-key`），后续部署时需要用到。

---

## 第四步：部署基础设施

```bash
cd infra
npm install
```

执行 CDK 部署，需要提供以下参数：

| 参数 | 说明 | 示例 |
| --- | --- | --- |
| `KeyPairName` | 第三步创建的 Key Pair 名称 | `super-agent-key` |
| `AdminEmail` | 初始管理员邮箱 | `admin@yourcompany.com` |
| `CognitoDomainPrefix` | Cognito 域名前缀（全球唯一） | `your-company-super-agent` |
| `AllowedCidr` | 允许访问的 IP 范围 | `0.0.0.0/0` 或你的办公 IP |

```bash
npx cdk deploy SuperAgentV2Stack \
  --parameters KeyPairName=super-agent-key \
  --parameters AdminEmail=admin@yourcompany.com \
  --parameters CognitoDomainPrefix=your-company-super-agent \
  --parameters AllowedCidr=0.0.0.0/0 \
  --region us-west-2
```

CDK 会显示将要创建的 IAM 资源列表，输入 `y` 确认。

部署大约需要 **10–15 分钟**（主要等待 RDS 创建）。完成后会输出一组关键信息，类似：

```
Outputs:
SuperAgentV2Stack.PublicIP = 54.x.x.x
SuperAgentV2Stack.InstanceId = i-0xxxxxxxxx
SuperAgentV2Stack.CognitoUserPoolId = us-west-2_xxxxxxx
SuperAgentV2Stack.CognitoClientId = xxxxxxxxxxxxxxxxx
SuperAgentV2Stack.CognitoDomainUrl = your-company-super-agent.auth.us-west-2.amazoncognito.com
SuperAgentV2Stack.DBSecretArn = arn:aws:secretsmanager:...
SuperAgentV2Stack.AvatarBucketName = superagentv2stack-avatarbucket-xxxxx
```

> **请记录这些输出值**，后续步骤会用到。

---

## 第五步：运行 Post-Deploy 脚本

回到项目根目录，运行 post-deploy 脚本完成剩余配置：

```bash
cd ../infra/scripts

chmod +x post-deploy-v2.sh

./post-deploy-v2.sh <SSH_KEY_PATH> <ADMIN_PASSWORD> [STACK_NAME] [REGION]
```

示例：

```bash
./post-deploy-v2.sh ~/super-agent-key.pem 'YourSecurePass123' SuperAgentV2Stack us-west-2
```

此脚本会自动完成以下操作：

1. 从 CloudFormation 读取所有 Stack 输出值
2. 更新 Cognito 回调 URL（设置为 Elastic IP）
3. 设置管理员密码
4. 通过 SSM 隧道连接 EC2，配置 `.env` 环境变量
5. 构建前端（自动生成 `.env.production`）
6. 将前端和后端代码同步到 EC2
7. 安装依赖、运行数据库迁移、Seed 初始数据、启动服务

整个过程大约需要 **5–10 分钟**。

---

## 第六步：验证部署

脚本完成后会输出访问地址。打开浏览器访问：

```
https://<YOUR_PUBLIC_IP>
```

> 由于使用自签名 SSL 证书，浏览器会提示安全警告，点击"继续访问"即可。

使用以下凭证登录：

- **邮箱**：你在第四步设置的 `AdminEmail`
- **密码**：你在第五步设置的 `ADMIN_PASSWORD`

### 健康检查

```bash
curl -k https://<YOUR_PUBLIC_IP>/api/health
```

### 通过 SSM 连接 EC2

```bash
aws ssm start-session --target <INSTANCE_ID> --region us-west-2
```

### 查看后端日志

```bash
# 通过 SSM 连接后
sudo journalctl -u super-agent-backend -f
# 或
tail -f /opt/super-agent/logs/backend.log
```

---

## 后续代码更新

当你修改了代码需要重新部署时，无需重新运行完整的 post-deploy 脚本。使用轻量级的 deploy 脚本即可：

```bash
cd infra/scripts
chmod +x deploy.sh

./deploy.sh ~/super-agent-key.pem SuperAgentV2Stack us-west-2
```

此脚本只会构建前端、同步代码、安装依赖、运行迁移并重启服务。

---

## 启用 Amazon Bedrock 模型访问

Super Agent 使用 Amazon Bedrock 上的 Claude 模型。你需要在 AWS 控制台中手动启用模型访问：

1. 打开 [Amazon Bedrock 控制台](https://console.aws.amazon.com/bedrock/)
2. 确保区域选择为 `us-west-2`（或你部署的区域）
3. 左侧菜单选择 **Model access**
4. 点击 **Manage model access**
5. 勾选以下 Anthropic 模型并提交申请：
   - `Claude Haiku 4.5`（默认使用）
   - `Claude Sonnet 4`（推荐同时启用）
6. 等待审批通过（通常即时生效）

---

## 可选：配置自定义域名

如果你有自己的域名，可以替换自签名证书：

1. 将域名 DNS A 记录指向 Elastic IP
2. 通过 SSM 连接 EC2，使用 Certbot 申请 Let's Encrypt 证书：

```bash
sudo certbot --nginx -d yourdomain.com
```

3. 更新 Cognito 回调 URL：

```bash
aws cognito-idp update-user-pool-client \
  --user-pool-id <COGNITO_USER_POOL_ID> \
  --client-id <COGNITO_CLIENT_ID> \
  --callback-urls "https://yourdomain.com/auth/callback" "http://localhost:5173/auth/callback" \
  --logout-urls "https://yourdomain.com/login" "http://localhost:5173/login" \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid email profile \
  --allowed-o-auth-flows-user-pool-client \
  --supported-identity-providers COGNITO \
  --region us-west-2
```

---

## 可选：配置 Langfuse 可观测性

Super Agent 支持集成 [Langfuse](https://langfuse.com/) 进行 Agent 执行追踪。通过 SSM 连接 EC2 后，编辑 `/opt/super-agent/.env`，添加：

```env
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_BASE_URL=https://us.cloud.langfuse.com
```

然后重启后端：

```bash
sudo systemctl restart super-agent-backend
```

---

## 清理资源

如果需要删除所有部署的资源：

```bash
cd infra
npx cdk destroy SuperAgentV2Stack --region us-west-2
```

> 注意：Cognito User Pool 和 RDS 快照设置了 RETAIN 策略，不会被自动删除。如需完全清理，请在 AWS 控制台中手动删除。

---

## 故障排查

| 问题 | 排查方法 |
| --- | --- |
| CDK 部署失败 | 检查 CloudFormation 控制台中的事件日志 |
| SSM 连接失败 | 确认 EC2 实例状态为 Running，SSM Agent 状态为 Online：`aws ssm describe-instance-information` |
| 后端启动失败 | 查看日志：`sudo journalctl -u super-agent-backend -n 50` |
| 数据库连接失败 | 确认 RDS 实例状态为 Available，安全组规则正确 |
| Cognito 登录失败 | 确认回调 URL 已更新为正确的 IP/域名 |
| Bedrock 调用失败 | 确认模型访问已启用，EC2 IAM Role 有 `bedrock:InvokeModel` 权限 |
| 页面显示 502 | 后端可能未启动，检查 `systemctl status super-agent-backend` |
