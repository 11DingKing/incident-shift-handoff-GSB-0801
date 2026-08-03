# 应急事件跨班次交接系统

围绕「事件 / 行动项 / 证据时间线 / 交接快照 / 逐项确认」构建，强并发一致性保证：

- **已签收交接包不可修改**：数据库触发器 `reject_signed_handoff_update` 在行级拒绝任何 UPDATE；快照以 `jsonb` 固化。
- **签收原子性**：签收快照、`handoff_signed` 时间线事件、审计事件在**同一个数据库事务**里产生。
- **乐观锁与字段级冲突**：行动项带 `version`，旧版本提交返回 `409` 与逐字段的 `base / current / attempted`，而不是静默覆盖。
- **逐项确认幂等**：`(handoff_id, COALESCE(supplemental_handoff_id,''), item_type, item_id)` 唯一约束 + `Idempotency-Key`，断线重试/重复提交不会产生第二份确认。
- **后续变化追加为补充事件**：签收后对行动项的更新、新增时间线都会写入 `supplemental_events` 并关联原交接包；未确认事项不会因签收而自动关闭。
- **实时最终收敛**：前端用 SSE 推送，断线自动降级为 3 秒轮询，交接包详情 3 秒兜底轮询；双会话交叉操作最终一致。
- **键盘可达 / 焦点恢复**：所有交互可键盘完成，状态更新与确认后焦点回到原控件。

初始事件 `inc-gd-20260729-01` 已内置两个行动项（复核东侧绕行路线 / 确认临时搭建物撤离结果）与两条时间线（主路封闭 / 现场证据入库），均带稳定 ID、责任方与发生时间。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 后端 | Node.js 22 LTS、TypeScript、Fastify 5、PostgreSQL 17、pg |
| 前端 | React 19、Vite 6、TypeScript |
| 测试 | Vitest 3（后端 API/并发、前端组件）、Playwright（双浏览器会话交叉竞争） |

## 目录结构

```
.
├── backend/
│   ├── src/
│   │   ├── migrations/      # 001_init … 005_action_item_revisions
│   │   ├── repositories/    # 数据访问
│   │   ├── services/        # 事务、乐观锁、幂等、事件总线
│   │   ├── routes/          # Fastify 路由（含 SSE）
│   │   ├── app.ts           # 应用装配与错误映射
│   │   └── index.ts         # 启动入口（自动迁移）
│   └── test/                # API + 并发测试
└── frontend/
    ├── src/
    │   ├── components/      # 行动项、时间线、交接面板、冲突提示
    │   ├── hooks/           # useIncidentLive（SSE+轮询）、useActor
    │   └── api.ts           # 带 Idempotency-Key 的客户端
    └── tests/e2e/           # Playwright 双会话竞争 + 键盘/焦点
```

## 前置条件

- Node.js >= 22
- PostgreSQL >= 14（开发环境使用 17）
- npm >= 10

### 创建数据库

```sql
CREATE DATABASE incident_handoff_gsb_0801_dev;
CREATE DATABASE incident_handoff_gsb_0801_test;
```

## 原生安装

在仓库根目录执行（npm workspaces 会同时安装前后端）：

```bash
npm install
```

## 后端配置

复制环境变量模板并按需修改：

```bash
cd backend
cp .env.example .env
```

关键变量：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | 开发库连接串 |
| `TEST_DATABASE_URL` | Vitest 使用的测试库 |
| `PORT` | HTTP 端口，默认 4000 |
| `CORS_ORIGIN` | 前端来源，默认 `http://localhost:5173` |

> 后端启动时会自动运行未应用的迁移；迁移记录写入 `schema_migrations`。

### 常用命令（在 `backend/` 下）

```bash
npm run migrate     # 单独执行迁移
npm run seed        # 迁移并确认种子数据
npm run dev         # tsx watch 热重载开发
npm run build       # tsc 编译到 dist/（并复制 migrations）
npm run start       # 运行编译产物
npm run typecheck   # tsc --noEmit
npm test            # 运行 Vitest（API + 并发，12 个用例）
```

## 前端常用命令（在 `frontend/` 下）

```bash
npm run dev         # Vite 开发服务器（5173，/api 代理到 4000）
npm run build       # 类型检查 + 生产构建到 dist/
npm run preview     # 预览生产构建
npm run typecheck   # tsc --noEmit
npm test            # 组件测试（Vitest + Testing Library）
npm run test:browser:install   # 安装 Playwright Chromium
npm run test:browser           # 运行浏览器测试（自动拉起前后端）
```

## 一键开发

```bash
# 终端 1：后端（先建库、配置 .env）
cd backend && npm run dev

# 终端 2：前端
cd frontend && npm run dev
```

打开 http://localhost:5173 ，右上角填写当前值班人即可开始操作。事件 ID 默认 `inc-gd-20260729-01`。

## 测试矩阵

### 后端 API 与并发（`backend/test`）

- 初始事件/行动项/时间线返回，带稳定 ID、责任方、版本号。
- 创建→逐项确认→签收：快照、`handoff_signed` 时间线、审计事件同时存在。
- 重复签收幂等，且不产生重复快照/时间线；直接 SQL UPDATE 已签收包被触发器拒绝。
- 行动项乐观锁更新并写入 `action_item_revisions` 版本历史。
- 重复确认（相同幂等键、相同无键请求、并发请求）只落一条。
- 签收后更新行动项自动产生 `supplemental_events`，快照仍为签收时状态，未确认项保持未确认。
- 只允许对已签收包追加补充事件。
- **并发**：两个客户端同版本改同一字段，一个成功、一个收到字段级冲突；并发签收只产生一份快照/时间线/审计；并发确认只落一条；签收后并发更新产生两条补充事件。

### 前端组件（`frontend/src/**/*.test.tsx`）

- 409 冲突时渲染字段级冲突面板（基准值/服务器值/尝试值/版本号）。
- 更新成功后触发收敛回调。

### 浏览器端到端（`frontend/tests/e2e`）

使用两个浏览器上下文模拟两值班员：

1. 会话 A 改行动项状态，会话 B 通过 SSE 最终收敛到相同状态。
2. 双方同时点击同一事项的「确认该项」，数据库只有一条确认。
3. 签收后更新行动项，另一会话看到补充事件，快照视图保持签收时状态。
4. 阻塞 B 的实时通道后，A 更新、B 用旧版本提交，页面显示字段级冲突而非静默覆盖；重新加载后收敛。
5. 键盘：`Ctrl+K` 聚焦值班人、`Tab` 可达控件、`Enter` 签收、状态更新与确认后焦点恢复。

运行浏览器测试：

```bash
cd frontend
npm run test:browser:install   # 首次需要
npm run test:browser
```

Playwright 会自动在 `:4000` 拉起后端、`:5173` 拉起前端，并在开始前把 `TEST_DATABASE_URL` 指向的库重置为种子状态。

## HTTP API 速览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/incidents/:id` | 事件详情（含行动项、时间线、交接包列表） |
| GET | `/api/incidents/:id/audit` | 审计事件 |
| GET | `/api/incidents/:id/events` | SSE 实时变更流 |
| PATCH | `/api/action-items/:id` | 乐观锁更新行动项，body 含 `expectedVersion` 与 `patch` |
| POST | `/api/incidents/:id/timeline` | 追加时间线事件 |
| POST | `/api/incidents/:id/handoffs` | 创建交接包（草稿） |
| GET | `/api/handoffs/:id` | 交接包详情（含确认、补充事件） |
| POST | `/api/handoffs/:id/sign` | 签收并原子固化快照 |
| POST | `/api/handoffs/:id/acknowledgements` | 逐项确认（幂等） |
| POST | `/api/handoffs/:id/supplemental-events` | 签收后追加补充事件 |

所有写操作建议带 `Idempotency-Key` 头；PATCH 行动项在版本冲突时返回：

```json
{
  "error": "optimistic_lock_conflict",
  "currentVersion": 2,
  "conflicts": [
    { "field": "status", "base": "in_progress", "current": "done", "attempted": "blocked" }
  ],
  "current": { "id": "...", "version": 2, "status": "done" }
}
```

## 并发与一致性设计要点

- **锁定字段**：`incident_id`、`handoff_id` 为外键且不可变；`action_items.status` 受 CHECK 约束；`version` 由 `UPDATE ... WHERE version = $expected` 原子递增。
- **字段级冲突**：`action_item_revisions` 保存每个版本的完整快照，旧版本提交时按字段比对 `base vs current`，仅把被他人改过的字段列入冲突。
- **原子签收**：`signHandoff` 在单事务内完成快照写入、时间线插入、审计插入；并发签收靠 `SELECT ... FOR UPDATE` + `status='draft'` 条件保证只有一方成功。
- **幂等**：写接口支持 `Idempotency-Key`（`idempotency_keys` 表），确认接口额外有唯一索引兜底，`ON CONFLICT DO NOTHING RETURNING` 让竞态失利方回读胜者而不是让事务失败。
- **不可变**：`handoffs` 与 `supplemental_handoffs` 上有 `BEFORE UPDATE` 触发器，已签收/补充包任何列更新都会抛 `integrity_constraint_violation`。
- **实时收敛**：SSE 断线即降级轮询；交接包详情另有 3 秒兜底轮询，保证即便丢事件也能最终一致。
