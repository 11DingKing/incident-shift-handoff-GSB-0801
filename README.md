# 应急事件交接系统

跨班次应急事件交接：围绕**事件、行动项、证据时间线、交接快照、逐项确认**五个域对象，
保证签收快照不可变、后续变化以补充事件追加、并发与断线重试不产生脏数据。

- 后端：Node.js 22 LTS + TypeScript + Fastify + PostgreSQL（`server/`）
- 前端：React 18 + Vite（`web/`）
- 初始事件：`inc-gd-20260729-01`（强降水与强对流，广东 2026-07-29），含行动项
  `ai-gd-20260729-01`「复核东侧绕行路线」、`ai-gd-20260729-02`「确认临时搭建物撤离结果」，
  以及时间线证据 `ev-gd-20260729-01`「主路封闭」、`ev-gd-20260729-02`「现场证据入库」。

## 一致性设计

| 约束 | 实现 |
| --- | --- |
| `incident_id` / `handoff_id` 锁定 | 外键不可变；更新接口不接受这两个字段 |
| 行动项状态锁定 | `CHECK (status IN ('open','in_progress','done','verified'))`，非法值 400 |
| 乐观版本号 | `action_items.version` / `handoffs.version`，更新必须携带 `expectedVersion` |
| 旧版本冲突 | 409 `VERSION_CONFLICT`，返回 `currentVersion` 与**字段级** `conflicts[]`（field/current/attempted），绝不静默覆盖 |
| 签收原子性 | 逐项快照（`handoff_items`）+ 交接包状态 + 审计事件在**同一事务**提交；失败整体回滚 |
| 签收后不可变 | 已签收交接包任何修改返回 409 `HANDOFF_LOCKED`；不可重复签收 |
| 签收后变化 | 只能追加 `kind='supplement'` 时间线事件且必须 `handoff_id` 关联原交接包；行动项更新自动生成补充事件 |
| 未确认不自动关闭 | 签收只复制快照，不改动 `action_items.status`；`handoff_items.confirmed` 默认 false |
| 逐项确认幂等 | 重复确认返回首次结果（`alreadyConfirmed: true`），不产生第二条审计 |
| 断线重试/重复提交 | `Idempotency-Key` 占位认领：并发同键严格只生效一次，其余请求重放首次响应 |
| 并发串行化 | 所有写路径 `SELECT ... FOR UPDATE` 行锁 |

## 目录

```
server/            后端
  migrations/      SQL 迁移（001 schema / 002 种子数据）
  src/             Fastify 应用（routes: incidents / actionItems / handoffs）
  test/            node:test API 与并发测试
web/               前端（React + Vite，/api 代理到 :3001）
```

## 一、准备 PostgreSQL

Docker（本仓库验证方式，端口 55432 避开本机 5432 占用）：

```bash
docker run -d --name pg-handoff \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=handoff \
  -p 55432:5432 postgres:16-alpine
```

或原生安装（macOS）：

```bash
brew install postgresql@16 && brew services start postgresql@16
createdb handoff
# 然后为下列命令设置 DATABASE_URL，例如：
export DATABASE_URL=postgres://$(whoami)@localhost:5432/handoff
```

## 二、后端（server/）

```bash
cd server
npm install            # 原生安装依赖
npm run migrate        # 应用迁移 + 种子数据（默认连接 localhost:55432/handoff）
npm run typecheck      # 类型检查（tsc --noEmit）
npm run build          # 构建到 dist/
npm test               # API + 并发测试（自动创建 handoff_test_api / handoff_test_conc 库）
npm run dev            # 开发启动（tsx watch，:3001）
# 或生产启动：
npm start              # node dist/index.js
```

环境变量：`DATABASE_URL`（默认 `postgres://postgres:postgres@localhost:55432/handoff`）、
`PORT`（默认 3001）、`TEST_DATABASE_URL`（测试库连接）。

## 三、前端（web/）

```bash
cd web
npm install            # 原生安装依赖
npm run typecheck      # 类型检查
npm run build          # 类型检查 + 产物构建（dist/）
npm run dev            # 开发启动（:5173，/api 代理到 :3001）
```

打开 http://localhost:5173/ 即可看到初始事件。

## 四、API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/incidents/:id` | 事件 + 行动项 + 交接包列表 |
| GET | `/api/incidents/:id/timeline` | 时间线（evidence/supplement/audit） |
| PATCH | `/api/action-items/:id` | 更新行动项（`expectedVersion` 必填，409 字段级冲突） |
| POST | `/api/incidents/:id/handoffs` | 创建草稿交接包 |
| GET | `/api/handoffs/:id` | 详情：草稿显示实时项；已签收显示锁定快照 + 补充事件 |
| PATCH | `/api/handoffs/:id` | 仅草稿可改；已签收 409 `HANDOFF_LOCKED` |
| POST | `/api/handoffs/:id/sign` | 签收：快照 + 状态 + 审计同事务原子产生 |
| POST | `/api/handoffs/:id/items/:itemId/confirm` | 逐项确认（幂等） |
| POST | `/api/handoffs/:id/supplements` | 追加补充事件（须已签收，自动关联） |

所有非 GET 请求支持 `Idempotency-Key` 头：断线重试/双击/并发同键均只生效一次；
同键用于不同路径返回 422 `IDEMPOTENCY_KEY_REUSED`。

## 五、测试

```bash
cd server && npm test    # 17 个用例
```

覆盖：种子数据完整性、版本递增、**旧版本 409 字段级冲突**、非法状态、签收原子性
（含失败回滚反向验证）、已签收不可变/不可重复签收、确认幂等、签收不自动关闭、
签收后更新自动生成补充事件、幂等键重放与并发同键、两客户端同版本并发一成一败、
双签收/双确认只记一次、签收后更新×确认交叉竞争。

浏览器侧已验证：双会话逐项确认、跨会话轮询收敛、字段级冲突 UI、焦点恢复、
键盘可达（原生 button/input + aria-live 播报）。
