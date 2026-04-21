# Super Agent 功能优化路线图

本文档记录待优化的功能点和技术改进思路。

---

## 调度系统优化 ✅ 已完成

### 实现方案

定时任务已迁移到 BullMQ Repeatable Jobs：

```
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│  Backend 1       │      │  Backend 2       │      │  Backend N       │
│  (Worker)        │      │  (Worker)        │      │  (Worker)        │
└────────┬─────────┘      └────────┬─────────┘      └────────┬─────────┘
         │                         │                         │
         └─────────────────────────┼─────────────────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │           Redis              │
                    │  ┌────────────────────────┐  │
                    │  │ ZSET: delayed jobs     │  │  ← BullMQ 原子调度
                    │  │ LIST: active jobs      │  │  ← 带锁执行
                    │  │ Repeatable job config  │  │  ← cron 配置
                    │  └────────────────────────┘  │
                    └──────────────────────────────┘
```

**文件位置：**
- `backend/src/services/schedule-queue.service.ts` — BullMQ 队列服务
- `backend/src/services/schedule.service.ts` — 调度业务逻辑
- `backend/src/setup/schedule-processor.ts` — 启动入口

**特性：**
| 特性 | 说明 |
|------|------|
| 多实例安全 | Redis Lua 脚本原子取任务 |
| 故障恢复 | Stalled job 检测 + 自动重试 |
| 精确调度 | 毫秒级精度，支持时区 |
| 持久化 | Redis 持久化 + 启动时从 DB 同步 |

**配置：**
```typescript
{
  lockDuration: 60000,      // 60 秒锁
  stalledInterval: 30000,   // 30 秒检查 stalled
  maxStalledCount: 2,       // 最多重试 2 次
  attempts: 3,              // 总共尝试 3 次
}
```

---

## 其他待优化项

（待补充）

---

*最后更新：2026-04-20*
