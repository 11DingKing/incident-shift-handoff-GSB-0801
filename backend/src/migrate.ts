import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(__dirname, '..', 'migrations');

const RESET = process.argv.includes('--reset');

async function main(): Promise<void> {
  if (RESET) {
    // Drop everything so `db:reset` gives a clean slate for local dev / tests.
    await pool.query(`
      DROP TABLE IF EXISTS
        idempotency_keys, audit_events, supplemental_events, acknowledgements,
        handoffs, timeline_events, action_items, incidents,
        schema_migrations CASCADE;
      DROP FUNCTION IF EXISTS reject_signed_handoff_update() CASCADE;
    `);
    console.log('reset: dropped existing objects');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
    if (rows.length > 0) {
      console.log(`skip: ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(resolve(migrationsDir, file), 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    console.log(`applied: ${file}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
