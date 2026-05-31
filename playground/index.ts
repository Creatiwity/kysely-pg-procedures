/**
 * kysely-pg-procedures — Playground
 *
 * Procedure definitions live in playground/procedures.ts (pure, no side effects).
 * This script compiles them and optionally applies to a local PG instance.
 *
 * Usage:
 *   npm run playground              → compile SQL, print, apply to local PG
 *   npm run playground -- --dry     → compile SQL, print only (no DB)
 *   npm run playground -- --debug   → compile with debug=true (snapshots active)
 *   npm run playground -- --log info|step|debug
 *   npm run playground -- --log step --target notify
 */

import { Pool } from 'pg'
import { compileAll, snapshotSetupSql, logSetupSql } from '../src/index.js'
import triggers from './procedures.js'

// ─── Parse CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const debug = args.includes('--debug')
const logIdx = args.indexOf('--log')
const log = (logIdx !== -1 ? args[logIdx + 1] : 'none') as 'none' | 'info' | 'step' | 'debug'
const targetIdx = args.indexOf('--target')
const logTarget = (targetIdx !== -1 ? args[targetIdx + 1] : 'table') as 'table' | 'notify'

// ─── Compile ──────────────────────────────────────────────────────────────────

const opts = { debug, log, logTarget }
const compiled = compileAll(triggers, opts)

console.log('\n' + '─'.repeat(72))
console.log('COMPILED SQL')
console.log('─'.repeat(72))
console.log(compiled)

if (log !== 'none') {
  console.log('\n' + '─'.repeat(72))
  console.log('LOG SETUP SQL (run once to create log tables)')
  console.log('─'.repeat(72))
  console.log(logSetupSql())
}

if (debug || log === 'debug') {
  console.log('\n' + '─'.repeat(72))
  console.log('SNAPSHOT SETUP SQL (run once to create snapshot tables)')
  console.log('─'.repeat(72))
  console.log(snapshotSetupSql())
}

if (dry) {
  console.log('\n[dry run] Skipping DB apply.\n')
  process.exit(0)
}

// ─── Apply to local PG ────────────────────────────────────────────────────────

const pool = new Pool({
  host: process.env['PG_HOST'] ?? 'localhost',
  port: Number(process.env['PG_PORT'] ?? 5433),
  user: process.env['PG_USER'] ?? 'kysely_test',
  password: process.env['PG_PASSWORD'] ?? 'kysely_test',
  database: process.env['PG_DATABASE'] ?? 'kysely_test',
})

const client = await pool.connect()

try {
  await client.query('BEGIN')

  await client.query(`
    CREATE TABLE IF NOT EXISTS playground_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      label TEXT NOT NULL,
      score INTEGER,
      audit_flag BOOLEAN DEFAULT FALSE
    )
  `)

  if (log !== 'none') await client.query(logSetupSql())
  if (debug || log === 'debug') await client.query(snapshotSetupSql())

  await client.query(compiled)

  const { rows } = await client.query<{ label: string; score: number }>(
    `INSERT INTO playground_items (label) VALUES ('hello') RETURNING label, score`,
  )
  const row = rows[0]

  console.log('\n' + '─'.repeat(72))
  console.log("SMOKE TEST — INSERT INTO playground_items (label) VALUES ('hello')")
  console.log('─'.repeat(72))
  console.log(`  label: ${row?.label}`)
  console.log(`  score: ${row?.score}  (expected: ${('hello'.length * 10)})`)
  console.log(row?.score === 50 ? '  ✅ trigger fired correctly' : '  ❌ unexpected score')

  await client.query('ROLLBACK')
  console.log('\n[rollback] Changes not persisted.\n')
} catch (err) {
  await client.query('ROLLBACK')
  console.error('\n❌ Error:', err)
} finally {
  client.release()
  await pool.end()
}
