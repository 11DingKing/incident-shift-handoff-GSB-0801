import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(__dirname, 'migrations');

export async function runMigrations(databaseUrl: string = config.databaseUrl): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const existing = await pool.query(
        'SELECT 1 FROM schema_migrations WHERE filename = $1',
        [file],
      );
      if (existing.rowCount && existing.rowCount > 0) continue;

      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations(filename) VALUES($1)',
          [file],
        );
        await client.query('COMMIT');
        console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
      process.argv[1]?.replace(/\\/g, '/')?.endsWith('src/db/migrate.ts');
  } catch {
    return false;
  }
})();

if (isMain) {
  runMigrations()
    .then(() => {
      console.log('[migrate] done');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[migrate] failed', err);
      process.exit(1);
    });
}
