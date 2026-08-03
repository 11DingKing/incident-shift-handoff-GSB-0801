import { config } from "./config.js";
import { buildApp } from "./app.js";
import { runMigrations } from "./migrate.js";
import { closePool } from "./db.js";

async function main(): Promise<void> {
  await runMigrations();
  const app = buildApp();
  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
    app.log.info(`应急事件交接系统后端已启动: http://localhost:${config.port}`);
  } catch (err) {
    app.log.error(err);
    await closePool();
    process.exit(1);
  }

  const shutdown = async () => {
    app.log.info("正在关闭服务...");
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
