/**
 * kysely-pg-procedures — Playground
 *
 * Usage:
 *   npm run playground              → compile SQL, print, apply to local PG
 *   npm run playground -- --dry     → compile SQL, print only (no DB)
 *   npm run playground -- --debug   → compile with debug=true (snapshots active)
 *   npm run playground -- --log info|step|debug
 *   npm run playground -- --log step --target notify
 */

import { Pool } from 'pg'
import {
  defineProcedure,
  defineTrigger,
  defineTempTable,
  compileAll,
  snapshotSetupSql,
  logSetupSql,
  sql,
} from '../src/index.js'

// ─── Parse CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const debug = args.includes('--debug')
const logIdx = args.indexOf('--log')
const log = (logIdx !== -1 ? args[logIdx + 1] : 'none') as 'none' | 'info' | 'step' | 'debug'
const targetIdx = args.indexOf('--target')
const logTarget = (targetIdx !== -1 ? args[targetIdx + 1] : 'table') as 'table' | 'notify'

// ─── Define your procedures here ──────────────────────────────────────────────

// Example 1 — BEFORE INSERT ROW trigger: auto-set score from label length
const scoreProc = defineProcedure(
  { name: 'playground_score_proc' },
  [],
  {},
  ({ sql: s, db }) => {
    db.set(db.NEW.score, sql`char_length(${db.NEW.label}) * 10`)
    db.return(db.NEW)
  },
)

const scoreTrigger = defineTrigger(
  {
    name: 'playground_score_trigger',
    table: 'playground_items',
    timing: 'BEFORE',
    events: ['INSERT'],
    forEach: 'ROW',
  },
  scoreProc,
)

// Example 2 — AFTER UPDATE STATEMENT trigger with temp table
const modifiedTable = defineTempTable(
  'PlaygroundModifiedItems',
  {
    itemId: { type: 'uuid', nullable: false },
    oldScore: { type: 'integer', nullable: true },
    newScore: { type: 'integer', nullable: true },
  },
  { as: 'modified' },
)

const auditProc = defineProcedure(
  { name: 'playground_audit_proc' },
  [modifiedTable],
  {},
  ({ sql: s, db }) => {
    db.modified.insertFrom(
      ['itemId', 'oldScore', 'newScore'],
      sql`
        SELECT ins."id", rem."score", ins."score"
        FROM "inserted" AS ins
        JOIN "removed" AS rem ON ins."id" = rem."id"
        WHERE ins."score" IS DISTINCT FROM rem."score"
      `,
    )

    db.if(db.modified.notExists(), () => {
      db.modified.delete()
      db.return(sql`NULL`)
    })

    db.snapshot('after_collect')

    db.execute(sql`
      UPDATE "playground_items" SET "audit_flag" = TRUE
      FROM "PlaygroundModifiedItems" AS m
      WHERE "playground_items"."id" = m."itemId"
        AND ${db.modified.filter('m')}
    `, { label: 'flag_modified_items' })

    db.return(sql`NULL`)
  },
)

const auditTrigger = defineTrigger(
  {
    name: 'playground_audit_trigger',
    table: 'playground_items',
    timing: 'AFTER',
    events: ['UPDATE'],
    forEach: 'STATEMENT',
    referencing: { old: 'removed', new: 'inserted' },
  },
  auditProc,
)

// ─── Compile ──────────────────────────────────────────────────────────────────

const opts = { debug, log, logTarget }
const compiled = compileAll([scoreTrigger, auditTrigger], opts)

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

  // Create test table if needed
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

  // Apply procedures + triggers
  await client.query(compiled)

  // Smoke test: insert a row, verify trigger fired
  const { rows } = await client.query<{ label: string; score: number }>(
    `INSERT INTO playground_items (label) VALUES ('hello') RETURNING label, score`,
  )
  const row = rows[0]

  console.log('\n' + '─'.repeat(72))
  console.log('SMOKE TEST — INSERT INTO playground_items (label) VALUES (\'hello\')')
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
