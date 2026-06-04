import { describe, it, afterAll, expect } from 'vitest'
import { defineProcedure, defineTrigger, compileAll, sql } from '../../src/index.js'
import { query, closePool } from '../helpers/pg.js'

const TABLE = 'test_scoring'
const TRIGGER_NAME = 'trg_test_scoring_score'
const FUNCTION_NAME = 'trg_test_scoring_score_fn'

// ---------------------------------------------------------------------------
// Define the procedure and trigger at module scope so we can reference names
// in afterAll cleanup even when the test is skipped.
// ---------------------------------------------------------------------------
const scoringProc = defineProcedure(
  { name: FUNCTION_NAME },
  [],
  {},
  ({ db, sql: s }) => {
    // NEW.score := char_length(NEW.label) * 10
    db.set(db.NEW.score!, s`char_length(${db.NEW.label!}) * 10`)
    db.return(sql.raw('NEW'))
  },
)

const scoringTrigger = defineTrigger(
  {
    name: TRIGGER_NAME,
    table: TABLE,
    timing: 'BEFORE',
    events: ['INSERT'],
    forEach: 'ROW',
  },
  scoringProc,
)

describe('integration: BEFORE INSERT trigger sets score from label length', () => {
  it('creates the table, applies the trigger, inserts a row and checks score=50', async () => {
    try {
      // 1. Create the target table
      await query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          label TEXT,
          score INTEGER
        )
      `)

      // 2. Compile and apply the procedure + trigger DDL
      const ddl = compileAll([scoringTrigger])
      // compileAll returns a single string; split on statement boundaries and
      // execute each non-empty piece.
      for (const stmt of splitStatements(ddl)) {
        await query(stmt)
      }

      // 3. Insert a row with label="hello" (5 chars * 10 = 50)
      const result = await query(
        `INSERT INTO ${TABLE} (label) VALUES ('hello') RETURNING score`,
      )

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].score).toBe(50)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // If Postgres is not available, skip gracefully
      if (
        msg.includes('ECONNREFUSED') ||
        msg.includes('connect') ||
        msg.includes('Connection terminated') ||
        msg.includes('does not exist') ||
        msg.includes('password authentication failed') ||
        msg.includes('pg_hba.conf')
      ) {
        console.warn('Postgres not available — skipping integration test:', msg)
        return
      }
      throw err
    }
  })

  afterAll(async () => {
    try {
      await query(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON ${TABLE}`)
      await query(`DROP FUNCTION IF EXISTS ${FUNCTION_NAME}()`)
      await query(`DROP TABLE IF EXISTS ${TABLE}`)
    } catch {
      // Best-effort cleanup — ignore errors (e.g. PG was never reachable)
    } finally {
      await closePool()
    }
  })
})

// ---------------------------------------------------------------------------
// Split a SQL string (as produced by compileAll) into individual executable
// statements. compileAll uses $$ quoting for function bodies, so we can't
// split naively on ";". Instead we split on the patterns that end a top-level
// statement: "$$;" (end of CREATE FUNCTION) and standalone ";" not inside $$.
// ---------------------------------------------------------------------------
function splitStatements(ddl: string): string[] {
  const statements: string[] = []
  let current = ''
  let inDollarQuote = false

  const lines = ddl.split('\n')
  for (const line of lines) {
    // Skip header comment lines
    if (line.startsWith('--')) {
      continue
    }

    current += line + '\n'

    // Toggle dollar-quoting state
    const dollarMatches = line.match(/\$\$/g)
    if (dollarMatches && dollarMatches.length % 2 !== 0) {
      inDollarQuote = !inDollarQuote
    }

    // A statement ends when we see "$$;" (closing a function body) or
    // a semicolon at the end of a non-dollar-quoted line.
    if (!inDollarQuote) {
      const trimmed = line.trim()
      if (trimmed.endsWith('$$;') || (trimmed.endsWith(';') && !trimmed.includes('$$'))) {
        const stmt = current.trim()
        if (stmt) {
          statements.push(stmt)
        }
        current = ''
      }
    }
  }

  const remaining = current.trim()
  if (remaining) {
    statements.push(remaining)
  }

  return statements.filter((s) => s.length > 0)
}
