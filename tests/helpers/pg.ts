import pg from 'pg'

const { Pool } = pg

export type { QueryResult } from 'pg'
import type { PoolClient, QueryResult } from 'pg'

export const pool = new Pool({
  host: process.env.PG_HOST ?? 'localhost',
  port: Number(process.env.PG_PORT ?? 5433),
  user: process.env.PG_USER ?? 'kysely_test',
  password: process.env.PG_PASSWORD ?? 'kysely_test',
  database: process.env.PG_DATABASE ?? 'kysely_test',
})

export async function query(sql: string, values?: unknown[]): Promise<QueryResult> {
  return pool.query(sql, values)
}

export async function withTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await fn(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

export async function closePool(): Promise<void> {
  await pool.end()
}
