import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const app = buildApp();

async function start(): Promise<void> {
  try {
    await app.listen({ host: config.host, port: config.port });
    console.log(`incident-handoff backend listening on http://${config.host}:${config.port}`);
  } catch (err) {
    console.error(err);
    await pool.end();
    process.exit(1);
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

void start();
