import { buildApp } from './app.js';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';

async function main() {
  await runMigrations();
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  console.log(`[server] listening on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
