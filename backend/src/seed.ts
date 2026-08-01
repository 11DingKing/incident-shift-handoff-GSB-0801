import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";
import { runMigrations } from "./migrate.js";

const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;

async function seed(): Promise<void> {
  await runMigrations();
  const { rows } = await pool.query(
    `SELECT id, title, status FROM incidents WHERE id = $1`,
    ["inc-gd-20260729-01"]
  );
  console.log("种子数据就绪:", rows[0]);
}

if (isMain) {
  seed()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
