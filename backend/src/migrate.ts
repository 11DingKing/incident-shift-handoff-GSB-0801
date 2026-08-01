import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;

function candidates(): string[] {
  return [
    resolve(here, "migrations"),
    resolve(process.cwd(), "src", "migrations"),
    resolve(process.cwd(), "dist", "migrations"),
    resolve(process.cwd(), "migrations"),
  ];
}

function migrationsDir(): string {
  for (const dir of candidates()) {
    if (existsSync(dir)) return dir;
  }
  throw new Error("找不到 migrations 目录");
}

export async function runMigrations(): Promise<void> {
  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`
  );

  for (const file of files) {
    const { rows } = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name = $1",
      [file]
    );
    if (rows.length > 0) {
      continue;
    }
    const sql = readFileSync(join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (name) VALUES ($1)",
        [file]
      );
      await client.query("COMMIT");
      console.log(`  ✓ 已应用迁移 ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`  ✗ 迁移失败 ${file}`);
      throw err;
    } finally {
      client.release();
    }
  }
}

if (isMain) {
  runMigrations()
    .then(() => pool.end())
    .then(() => {
      console.log("迁移完成");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
