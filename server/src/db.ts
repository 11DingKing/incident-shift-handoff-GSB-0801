import pg from 'pg';

const { Pool } = pg;

export type Db = pg.Pool;

export function createPool(connectionString?: string): pg.Pool {
  return new Pool({
    connectionString:
      connectionString ??
      process.env.DATABASE_URL ??
      'postgres://postgres:postgres@localhost:55432/handoff',
    max: 10,
  });
}

export async function withTx<T>(
  pool: pg.Pool,
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
