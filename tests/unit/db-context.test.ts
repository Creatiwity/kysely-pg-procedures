import { describe, it, expect } from 'vitest'
import { buildDbContext } from '../../src/db-context.js'
import { defineTempTable } from '../../src/index.js'
import { sql } from '../../src/sql.js'
import type { Statement } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Helper — run a callback with a fresh DbContext and return the statements it
// produced. This mirrors how executeBody() works internally.
// ---------------------------------------------------------------------------
function capture(
  cb: (db: ReturnType<typeof buildDbContext>['db']) => void,
  opts: { tempTables?: Parameters<typeof defineTempTable<string, any>>[]; vars?: Record<string, any> } = {},
): Statement[] {
  const tables = (opts.tempTables ?? []).map((args) => defineTempTable(...args))
  const { db, getStatements, _runWithRootFrame } = buildDbContext(tables, opts.vars ?? {}) as any
  _runWithRootFrame(() => cb(db))
  return getStatements()
}

// ---------------------------------------------------------------------------
// 1. db.NEW.someCol produces a SqlFragment with text containing NEW."someCol"
// ---------------------------------------------------------------------------
describe('buildDbContext', () => {
  it('db.NEW.someCol has text NEW."someCol"', () => {
    const stmts = capture((db) => {
      db.set(db.NEW.someCol!, sql.raw('1'))
    })

    expect(stmts).toHaveLength(1)
    const stmt = stmts[0]!
    expect(stmt.kind).toBe('set')
    if (stmt.kind === 'set') {
      // target is the full text of the ColumnRef (NEW."someCol")
      expect(stmt.target).toContain('NEW."someCol"')
    }
  })

  // -------------------------------------------------------------------------
  // 2. db.if pushes kind="if" with correct then/else arrays
  // -------------------------------------------------------------------------
  it('db.if pushes a statement with kind="if" and correct then/else bodies', () => {
    const stmts = capture((db) => {
      db.if(
        sql.raw('TRUE'),
        () => {
          db.set('a', sql.raw('1'))
        },
        () => {
          db.set('b', sql.raw('2'))
        },
      )
    })

    expect(stmts).toHaveLength(1)
    const stmt = stmts[0]!
    expect(stmt.kind).toBe('if')

    if (stmt.kind === 'if') {
      expect(stmt.condition.text).toBe('TRUE')
      expect(stmt.then).toHaveLength(1)
      expect(stmt.then[0]!.kind).toBe('set')

      expect(stmt.else).toBeDefined()
      expect(stmt.else).toHaveLength(1)
      expect(stmt.else![0]!.kind).toBe('set')
    }
  })

  // -------------------------------------------------------------------------
  // 3. Nested db.if inside db.if — inner statements nested, not flat
  // -------------------------------------------------------------------------
  it('nested db.if produces inner statements inside the outer then block, not flat', () => {
    const stmts = capture((db) => {
      db.if(
        sql.raw('x > 0'),
        () => {
          db.if(
            sql.raw('y > 0'),
            () => {
              db.set('z', sql.raw('1'))
            },
          )
        },
      )
    })

    // Top level has exactly one statement (the outer if)
    expect(stmts).toHaveLength(1)
    const outer = stmts[0]!
    expect(outer.kind).toBe('if')

    if (outer.kind === 'if') {
      // The outer then block contains the inner if (not the set directly)
      expect(outer.then).toHaveLength(1)
      const inner = outer.then[0]!
      expect(inner.kind).toBe('if')

      if (inner.kind === 'if') {
        expect(inner.then).toHaveLength(1)
        expect(inner.then[0]!.kind).toBe('set')
      }
    }
  })

  // -------------------------------------------------------------------------
  // 4. db.switch pushes kind="case" with correct branches
  // -------------------------------------------------------------------------
  it('db.switch pushes kind="case" with correct branches and else', () => {
    const stmts = capture((db) => {
      db.switch(db.NEW.status!, {
        pending: () => {
          db.set('flag', sql.raw('0'))
        },
        done: () => {
          db.set('flag', sql.raw('1'))
        },
        _else: () => {
          db.set('flag', sql.raw('-1'))
        },
      })
    })

    expect(stmts).toHaveLength(1)
    const stmt = stmts[0]!
    expect(stmt.kind).toBe('case')

    if (stmt.kind === 'case') {
      expect(stmt.expr.text).toContain('NEW."status"')
      expect(stmt.branches).toHaveLength(2)
      expect(stmt.branches[0]![0]).toBe('pending')
      expect(stmt.branches[1]![0]).toBe('done')
      expect(stmt.else).toBeDefined()
      expect(stmt.else).toHaveLength(1)
    }
  })

  // -------------------------------------------------------------------------
  // 5. db.set pushes kind="set"
  // -------------------------------------------------------------------------
  it('db.set pushes a statement with kind="set"', () => {
    const stmts = capture((db) => {
      db.set('my_var', sql.raw('42'))
    })

    expect(stmts).toHaveLength(1)
    const stmt = stmts[0]!
    expect(stmt.kind).toBe('set')

    if (stmt.kind === 'set') {
      expect(stmt.target).toBe('my_var')
      expect(stmt.value.text).toBe('42')
    }
  })

  // -------------------------------------------------------------------------
  // 6. db.return pushes kind="return"
  // -------------------------------------------------------------------------
  it('db.return pushes a statement with kind="return"', () => {
    const stmts = capture((db) => {
      db.return(sql.raw('NEW'))
    })

    expect(stmts).toHaveLength(1)
    const stmt = stmts[0]!
    expect(stmt.kind).toBe('return')

    if (stmt.kind === 'return') {
      expect(stmt.value?.text).toBe('NEW')
    }
  })

  it('db.return() without argument pushes kind="return" with no value', () => {
    const stmts = capture((db) => {
      db.return()
    })

    expect(stmts).toHaveLength(1)
    const stmt = stmts[0]!
    expect(stmt.kind).toBe('return')

    if (stmt.kind === 'return') {
      expect(stmt.value).toBeUndefined()
    }
  })

  // -------------------------------------------------------------------------
  // 7. db.catch pushes kind="catch"
  // -------------------------------------------------------------------------
  it('db.catch pushes a statement with kind="catch"', () => {
    const stmts = capture((db) => {
      db.catch({
        unique_violation: () => {
          db.return(sql.raw('NULL'))
        },
      })
    })

    expect(stmts).toHaveLength(1)
    const stmt = stmts[0]!
    expect(stmt.kind).toBe('catch')

    if (stmt.kind === 'catch') {
      expect(stmt.handlers).toHaveLength(1)
      expect(stmt.handlers[0]!.when).toBe('unique_violation')
      expect(stmt.handlers[0]!.then).toHaveLength(1)
      expect(stmt.handlers[0]!.then[0]!.kind).toBe('return')
    }
  })

  // -------------------------------------------------------------------------
  // 8. temp table helper accessible via db[alias] when defineTempTable called with { as }
  // -------------------------------------------------------------------------
  it('db[alias] returns the TempTableHelper when defineTempTable is called with { as: "alias" }', () => {
    const tableArgs = ['scoring_items', { score: 'integer' as const }, { as: 'items' }] as const

    const tables = [defineTempTable(...tableArgs)]
    const { db, getStatements, _runWithRootFrame } = buildDbContext(tables, {}) as any

    let helper: any
    _runWithRootFrame(() => {
      helper = (db as any)['items']
    })

    expect(helper).toBeDefined()
    expect(helper.name).toBe('scoring_items')
    // The helper should have the standard TempTableHelper interface
    expect(typeof helper.insert).toBe('function')
    expect(typeof helper.delete).toBe('function')
    expect(typeof helper.exists).toBe('function')
  })
})
