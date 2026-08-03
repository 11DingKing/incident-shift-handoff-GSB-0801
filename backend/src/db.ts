import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

// Keep TIMESTAMPTZ as ISO strings so JSON responses are stable and comparable.
pg.types.setTypeParser(1184, (v) => (v === null ? null : new Date(v).toISOString()));
pg.types.setTypeParser(1114, (v) => (v === null ? null : new Date(v + 'Z').toISOString()));

export const pool = new Pool({ connectionString: config.databaseUrl });

export type QueryRunner = Pick<pg.PoolClient, 'query'>;

/**
 * Runs `fn` inside a single SERIALIZABLE-safe transaction. All writes that must
 * be atomic (snapshot + timeline + audit at sign-off, etc.) go through here.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
