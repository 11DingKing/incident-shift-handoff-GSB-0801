import { buildApp } from './app.js';
import { createPool } from './db.js';

const port = Number(process.env.PORT ?? 3001);
const pool = createPool();
const app = await buildApp(pool);

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
