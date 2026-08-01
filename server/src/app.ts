import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { ApiError } from './errors.js';
import { actionItemRoutes } from './routes/actionItems.js';
import { handoffRoutes } from './routes/handoffs.js';
import { incidentRoutes } from './routes/incidents.js';

export async function buildApp(pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  await app.register(cors, { origin: true });

  // 幂等键：占位认领模式。先 INSERT 占位（并发同键只有一个认领成功），
  // 未认领者等待首个请求完成后重放其响应——断线重试/重复提交/并发同键都只生效一次。
  app.addHook('preHandler', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key === '' || req.method === 'GET') return;
    const claimed = await pool.query(
      `INSERT INTO idempotency_keys (key, method, path) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key, req.method, req.url],
    );
    if (claimed.rowCount !== null && claimed.rowCount > 0) return; // 认领成功，继续执行

    const existing = await pool.query(
      'SELECT method, path, status_code, response FROM idempotency_keys WHERE key = $1',
      [key],
    );
    const hit = existing.rows[0];
    if (hit.method !== req.method || hit.path !== req.url) {
      return reply.code(422).send({
        error: { code: 'IDEMPOTENCY_KEY_REUSED', message: '幂等键被用于不同请求' },
      });
    }
    // 等待认领者完成（最长约 5s），随后重放其响应
    for (let i = 0; i < 100; i++) {
      const r = await pool.query(
        'SELECT status_code, response FROM idempotency_keys WHERE key = $1',
        [key],
      );
      if (r.rows[0].response !== null) {
        return reply.code(r.rows[0].status_code).send(r.rows[0].response);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return reply.code(409).send({
      error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: '相同请求正在处理中，请稍后重试' },
    });
  });

  // 请求完成后由认领者写入响应；5xx 则删除占位允许客户端重试
  app.addHook('onSend', async (req, reply, payload) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key === '' || req.method === 'GET') return payload;
    if (typeof payload !== 'string') return payload;
    try {
      if (reply.statusCode >= 500) {
        await pool.query(
          'DELETE FROM idempotency_keys WHERE key = $1 AND response IS NULL',
          [key],
        );
      } else {
        await pool.query(
          `UPDATE idempotency_keys SET status_code = $2, response = $3
            WHERE key = $1 AND response IS NULL`,
          [key, reply.statusCode, JSON.parse(payload)],
        );
      }
    } catch {
      // 存储失败不影响主流程
    }
    return payload;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, ...(err.details ?? {}) },
      });
    }
    app.log.error(err);
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });

  app.get('/api/health', async () => ({ ok: true }));
  incidentRoutes(app, pool);
  actionItemRoutes(app, pool);
  handoffRoutes(app, pool);
  return app;
}
