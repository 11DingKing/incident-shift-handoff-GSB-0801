# 应急事件交接系统 (Incident Shift Handoff)

面向跨班次强降水/强对流应急处置的交接系统。接班人看到的不只是一段摘要，而是：

- **事件** (`incident_id`) 与**行动项**（稳定 ID、责任方、发生时间、乐观版本号）
- **证据时间线**（道路封闭、证据入库等追加式事件）
- **交接包快照**：创建时把行动项与时间线原子冻结
- **逐项确认 + 签收**：未逐项确认的事项不会因为签收而自动关闭
- **签收后补充事件**：签收后发生的变化只能追加，并明确关联原交接包
- **乐观锁与字段级冲突**：旧版本提交返回 409，逐字段给出 `submitted` / `current` / `current_version`，不静默覆盖
- **幂等签收**：相同 `(handoff, action_item, confirmed_by)` 的重复提交/断线重试不会产生第二份确认
- **原子事务**：交接包快照、时间线、审计事件在同一数据库事务内产生
- **实时收敛**：前端轮询拉取权威状态，冲突后可“载入最新版本并重试”

技术栈：Node.js LTS + TypeScript + Fastify + PostgreSQL（后端）；React + Vite（前端）；Vitest 单元/并发测试；Playwright 双浏览器会话端到端测试。

---

## 目录结构

```
.
├── backend/    # Fastify + TypeScript + PostgreSQL
│   ├── src/
│   │   ├── db/migrations/   # SQL 迁移（001_init.sql, 002_*.sql）
│   │   ├── db/pool.ts       # 连接池 + withTransaction
│   │   ├── db/migrate.ts    # 迁移运行器
│   │   ├── db/seed.ts       # 初始事件 inc-gd-20260729-01
│   │   ├── repo.ts          # 仓储层（乐观锁、原子快照、幂等签收）
│   │   ├── routes.ts        # HTTP API
│   │   ├── app.ts / server.ts
│   │   ├── config.ts / errors.ts / types.ts
│   └── tests/               # API + 并发测试（16 个）
└── frontend/   # React + Vite
    ├── src/
    │   ├── api.ts                 # API 客户端（幂等键、X-Actor 编码）
    │   ├── useIncidentData.ts     # 轮询与实时收敛
    │   ├── ActionItemCard.tsx     # 行动项 + 字段级冲突 UI
    │   ├── Timeline.tsx
    │   ├── HandoffPanel.tsx       # 逐项确认 / 签收 / 补充事件
    │   └── App.tsx
    ├── src/__tests__/             # 组件测试（5 个）
    └── e2e/                       # Playwright 双会话测试（5 个）
```

初始事件 `inc-gd-20260729-01` 包含：
- 行动项：`ai-gd-20260729-route-review`（复核东侧绕行路线）、`ai-gd-20260729-temp-structure`（确认临时搭建物撤离结果）
- 时间线：`tl-gd-20260729-road-closure`（主路封闭）、`tl-gd-20260729-evidence-ingest`（现场证据入库）

---

## 环境要求

- Node.js **20+ LTS**（开发机使用 v22）
- PostgreSQL **14+**（开发机使用 17）
- npm 10+

确保 PostgreSQL 正在运行并监听 `localhost:5432`，且存在可免密/受信连接的 `postgres` 角色。
开发与测试数据库：

```sql
CREATE DATABASE incident_handoff;
CREATE DATABASE incident_handoff_test;
```

后端连接串在 [backend/.env](backend/.env)（可从 `.env.example` 复制）：

```
DATABASE_URL=postgres://postgres@localhost:5432/incident_handoff
TEST_DATABASE_URL=postgres://postgres@localhost:5432/incident_handoff_test
PORT=3001
```

---

## 原生安装

分别安装前后端依赖（无需 monorepo 工具）：

```bash
# 后端
cd backend
npm install

# 前端
cd ../frontend
npm install
```

如需运行浏览器端到端测试，还需安装一次 Playwright 浏览器：

```bash
cd frontend
npx playwright install chromium
```

---

## 数据库迁移与种子

```bash
cd backend
npm run migrate     # 应用 src/db/migrations/*.sql
npm run seed        # 写入 inc-gd-20260729-01（含两个行动项、两条时间线）
```

`npm run dev` 启动后端时也会自动执行迁移。种子脚本可重复执行，会先清理该事件的旧数据。

---

## 类型检查、构建、测试

### 后端

```bash
cd backend
npm run typecheck   # tsc --noEmit
npm run build       # 输出到 dist/
npm test            # Vitest：API + 并发测试（16 个，顺序执行避免共享库冲突）
```

后端测试覆盖：
- 种子数据稳定 ID/责任方/时间/版本
- 乐观锁：正确版本更新并 `version+1`；旧版本返回 409 与字段级 `conflictFields`
- 交接包原子快照：行动项 + 时间线 + 审计事件同事务
- 逐项确认幂等：重复提交只有一行
- 包级签收原子翻转：并发双签收只翻转一次，`version` 只 +1
- 未确认事项不自动关闭
- 签收后追加时间线/更新行动项 → 生成关联的 `supplementary_events`，快照保持不变
- 并发竞争：两个客户端同时 PATCH v1，恰好一个 200、一个 409；失败方可 rebase 后成功

### 前端

```bash
cd frontend
npm run typecheck   # tsc --noEmit
npm run build       # tsc -b && vite build
npm test            # Vitest：组件测试（5 个）
npm run test:e2e    # Playwright：双浏览器会话 + 双 API 客户端（5 个，需要后端运行）
```

组件测试覆盖渲染、乐观锁更新成功、409 字段级冲突展示、键盘可达性与幂等键确定性。

浏览器端到端测试覆盖：
1. 两个浏览器会话竞争同一行动项：一个成功、另一个看到字段级冲突，轮询后最终收敛
2. 生成快照 → 逐项确认 → 签收；未确认项快照仍为 open
3. 签收后第二个 API 客户端更新行动项 → 出现“签收后补充”，快照状态不变
4. 两个 API 客户端用相同幂等键同时签收 → 只有一条包级确认，`version=2`
5. 键盘聚焦与冲突后焦点恢复

运行 `npm run test:e2e` 前请先启动后端（见下）。前端开发服务器由 Playwright 自动拉起，若 `:5173` 已被占用则复用现有实例。

---

## 启动

需要两个终端：

```bash
# 终端 1：后端（默认 :3001，启动时自动迁移）
cd backend
npm run dev
```

```bash
# 终端 2：前端（默认 :5173，/api 代理到 :3001）
cd frontend
npm run dev
```

打开 http://localhost:5173 。右上角可切换“当前值班员”（写入 `localStorage`），该身份用于所有写操作的 `X-Actor` 头。

生产模式：

```bash
cd backend && npm run build && npm start      # node dist/server.js
cd frontend && npm run build && npm run preview
```

---

## HTTP API 速览

所有写操作接受 `X-Actor` 头（URL 编码，支持中文）。行动项更新必须带 `expected_version`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/incidents/:incidentId` | 事件 |
| GET | `/api/incidents/:incidentId/action-items` | 行动项列表 |
| GET | `/api/incidents/:incidentId/timeline` | 时间线 |
| GET | `/api/incidents/:incidentId/handoffs` | 交接包列表 |
| PATCH | `/api/action-items/:id` | 更新行动项（body: `{status, expected_version, ...}`） |
| POST | `/api/incidents/:id/timeline` | 追加时间线 |
| POST | `/api/incidents/:id/handoffs` | 创建交接包（原子快照） |
| GET | `/api/handoffs/:handoffId` | 交接包详情（快照、确认、补充） |
| POST | `/api/handoffs/:handoffId/items/:actionItemId/acknowledge` | 逐项确认（幂等） |
| POST | `/api/handoffs/:handoffId/acknowledge` | 包级签收（幂等，原子翻转状态） |

409 冲突响应示例：

```json
{
  "error": "Action item ... was modified by someone else (current version 2, you sent 1)",
  "conflictFields": [
    { "field": "status", "submitted": "blocked", "current": "done", "current_version": 2 }
  ]
}
```

---

## 并发与一致性设计要点

- **乐观锁**：`action_items.version` 在每次更新时 `version = version + 1`；更新用 `SELECT ... FOR UPDATE` 校验 `expected_version`，不匹配则返回字段级冲突，绝不静默覆盖。
- **原子快照**：`createHandoff` 在单个事务中插入 `handoffs`、`handoff_items`（复制当前行动项状态与 `snapshot_version`）、`handoff_timeline` 和 `audit_events`。
- **幂等确认**：`handoff_acknowledgments` 上有 `(handoff_id, action_item_id, confirmed_by)` 唯一约束，以及针对包级签收（`action_item_id IS NULL`）的部分唯一索引，保证重复/并发提交只产生一行；包状态翻转用 `WHERE status='pending'` 守卫，只 +1 一次。
- **不可变快照 + 补充事件**：签收后更新行动项或追加时间线会写入 `supplementary_events` 关联原 `handoff_id`，`handoff_items` 中的快照状态永不改变。
- **实时收敛**：前端每 2s 拉取行动项/时间线/交接包；冲突后展示服务器当前版本，用户可 rebase 重试，最终多端状态一致。
