# 应急事件交接系统（Incident Shift Handoff）

跨值班班次的应急事件交接系统。围绕**事件（incident）**、**行动项（action item）**、
**证据时间线（timeline / evidence）**、**交接快照（handoff snapshot）** 与
**逐项确认（per-item acknowledgement）** 展开，专为“强降水/强对流跨多个班次”这类
长时间、多人交叉操作的场景设计。

接班人不仅能看到摘要，还能看到：哪些行动项没做完、证据何时入库、谁确认过什么，
以及**签收之后又发生了哪些变化**。

- 后端：Node.js LTS（v20+，已在 v22 验证）、TypeScript、Fastify、PostgreSQL（`pg`）
- 前端：React + Vite + TypeScript，Playwright 浏览器测试

## 核心不变量（Invariants）

1. **稳定 ID**：`incident_id`、`handoff_id`、行动项 / 时间线 / 补充事件 / 确认均有稳定 ID，
   每条数据都带责任方（`responsible_party`）与发生时间（`occurred_at`）。
2. **乐观并发**：`incidents` / `action_items` / `handoffs` 带整型 `version`。
   使用旧版本更新会返回 **HTTP 409 字段级冲突**（`conflicts` 精确到字段），
   而不是静默覆盖。
3. **签收即冻结**：交接包一旦签收（`status = 'signed'`）即不可修改——数据库触发器
   拒绝对已签收行的任何 `UPDATE`。签收时的 `incident + action_items + timeline` 快照、
   时间线 / 审计事件、状态流转都在**同一个数据库事务中原子产生**。
4. **未确认不因签收自动关闭**：签收不会关闭或修改任何行动项，逐项确认依然需要人工进行。
5. **签收后变化只能追加**：只能以 `supplemental_events` 形式追加，并显式关联
   （`parent_handoff_id`）到原交接包，不改动已冻结的快照。
6. **重试 / 重复提交安全**：确认、签收、追加均支持 `Idempotency-Key`；
   `acknowledgements` 上有 `(handoff_id, item_type, item_id)` 唯一约束，
   断线重试或并发重复提交都不会产生第二份确认，也不会改变已签收的视图。

---

## 环境要求

- Node.js **v20 LTS 或更高**（已在 v22 验证）
- PostgreSQL **14+**（已在 v17 验证），本机可连接

确认版本：

```bash
node --version
psql --version
```

## 一次性数据库准备

创建开发库与测试库（测试库会在测试之间被 TRUNCATE）：

```bash
createdb incident_handoff_gsb_0801_dev
createdb incident_handoff_gsb_0801_test
```

> 若你的 PostgreSQL 用户 / 主机不同，请编辑 `backend/.env`（可从 `backend/.env.example` 复制）。
> 默认连接串使用当前系统用户，无密码本地连接。

---

## 后端（backend/）

```bash
cd backend
cp .env.example .env          # 如尚未创建 .env
npm install                   # 原生安装依赖
npm run typecheck             # 类型检查
npm run migrate               # 建表（幂等；--reset 可重建）
npm run seed                  # 写入初始事件 inc-gd-20260729-01
npm run build                 # 编译到 dist/
npm test                      # API / 并发测试（使用 TEST_DATABASE_URL）
npm start                     # 启动已编译服务（默认 http://0.0.0.0:8080）
```

开发热重载：`npm run dev`。一键重置并重灌种子数据：`npm run db:reset`。

> 测试会自动对 `TEST_DATABASE_URL` 应用迁移，并在每个用例前 TRUNCATE 重置，
> 因此可安全地反复运行 `npm test`。

### 初始数据

`npm run seed` 写入事件 **`inc-gd-20260729-01`**（广东强降水与强对流应急事件），包含：

- 行动项 `act-gd-20260729-01-a1`：复核东侧绕行路线（进行中，交通协调组）
- 行动项 `act-gd-20260729-01-a2`：确认临时搭建物撤离结果（待处理，现场处置组）
- 时间线 `tl-gd-20260729-01-e1`：主路封闭（road_closure，交通协调组）
- 时间线 `tl-gd-20260729-01-e2`：现场证据入库（evidence_intake，现场处置组）

### 主要 API

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /api/incidents/:id` | 事件聚合视图（行动项 / 时间线 / 交接包 / 确认 / 补充事件） |
| `POST /api/incidents/:id/timeline` | 追加时间线 / 证据事件 |
| `PATCH /api/incidents/:id/action-items/:itemId` | 乐观锁更新行动项（需 `expected_version`，冲突返回 409） |
| `POST /api/incidents/:id/handoffs` | 创建交接草稿 |
| `POST /api/incidents/:id/handoffs/:handoffId/sign-off` | 签收（原子冻结快照，支持 `Idempotency-Key`） |
| `GET /api/handoffs/:handoffId` | 交接包详情（含快照 / 确认 / 补充事件） |
| `POST /api/handoffs/:handoffId/acknowledgements` | 逐项确认（幂等，支持 `Idempotency-Key`） |
| `POST /api/incidents/:id/handoffs/:handoffId/supplemental` | 为已签收交接包追加补充事件 |

`Idempotency-Key` 通过请求头 `Idempotency-Key:` 或请求体 `idempotency_key` 传入。

---

## 前端（frontend/）

```bash
cd frontend
npm install                   # 原生安装依赖
npm run typecheck             # 类型检查
npm run build                 # 类型编译 + 生产构建到 dist/
npm run test:install          # 首次运行前安装 Playwright Chromium
npm test                      # 浏览器测试（自动拉起后端[测试库]与前端）
npm run dev                   # 开发服务器 http://localhost:5173
```

开发时前端通过 Vite 代理把 `/api` 转发到后端（默认 `:8080`，
可用环境变量 `VITE_API_PORT` 覆盖）。请先启动后端 `npm start`（或 `npm run dev`）。

### 浏览器测试覆盖

`frontend/tests/handoff.spec.ts` 会自动启动一个连向 **测试库** 的后端实例
（端口 8199，开启 `ALLOW_TEST_RESET`）和一个 Vite 服务（端口 5199），
每个用例前调用 `/api/test/reset` 重置数据，覆盖：

- 键盘操作更新行动项状态并**恢复焦点**
- 旧乐观版本触发**字段级冲突**且不静默覆盖
- 签收生成**不可变快照**，后续变化不改动已冻结视图
- 签收**不自动关闭**未确认项
- **重复确认**不产生第二份确认
- **两个浏览器会话交叉竞争**同一项确认，最终收敛为单条确认
- 签收后**追加补充事件**并关联原交接包

> `/api/test/reset` 仅在设置 `ALLOW_TEST_RESET=1` 时注册，正式部署不会暴露。

---

## 手动制造交叉竞争

系统可用两个浏览器会话 + 两个 API 客户端并发操作，观察冲突与幂等行为，例如：

```bash
# 客户端 A 抢先把 a1 从 v1 更新为“已完成”
curl -X PATCH localhost:8080/api/incidents/inc-gd-20260729-01/action-items/act-gd-20260729-01-a1 \
  -H 'content-type: application/json' \
  -d '{"expected_version":1,"status":"done","actor":"客户端A"}'

# 客户端 B 仍用旧版本 v1 更新 -> 返回 409 字段级冲突
curl -X PATCH localhost:8080/api/incidents/inc-gd-20260729-01/action-items/act-gd-20260729-01-a1 \
  -H 'content-type: application/json' \
  -d '{"expected_version":1,"status":"blocked","actor":"客户端B"}'

# 带同一个 Idempotency-Key 重复签收 -> 返回同一份结果，不会二次签收
curl -X POST localhost:8080/api/incidents/inc-gd-20260729-01/handoffs/<handoff_id>/sign-off \
  -H 'content-type: application/json' -H 'Idempotency-Key: signoff-1' \
  -d '{"signed_off_by":"王五","expected_version":1}'
```

---

## 目录结构

```
backend/
  migrations/001_init.sql     # 表结构 + 已签收不可变触发器
  src/
    config.ts  db.ts          # 配置与连接池 / 事务封装
    types.ts   errors.ts ids.ts
    service.ts                # 领域逻辑：乐观锁、原子签收、幂等确认、补充事件
    app.ts     index.ts       # Fastify 路由与服务入口
    migrate.ts seed.ts        # 迁移与种子
  test/api.test.ts            # API / 并发 / 幂等 / 不可变 测试（vitest）
frontend/
  src/
    api.ts types.ts           # API 客户端与类型
    App.tsx main.tsx styles.css
  tests/handoff.spec.ts       # Playwright 浏览器测试
  playwright.config.ts        # 自动拉起测试后端 + 前端
```
