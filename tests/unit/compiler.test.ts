import { describe, it, expect } from 'vitest'
import {
  defineProcedure,
  defineTrigger,
  defineTempTable,
  compileAll,
  compileTrigger,
  sql,
} from '../../src/index.js'

// ---------------------------------------------------------------------------
// Helper — build a minimal BEFORE ROW trigger procedure
// ---------------------------------------------------------------------------
function makeProc(name: string, body: Parameters<typeof defineProcedure>[3]) {
  return defineProcedure({ name }, [], {}, body)
}

// ---------------------------------------------------------------------------
// 1. Simple BEFORE ROW trigger: db.set + db.return(db.NEW)
// ---------------------------------------------------------------------------
describe('compileProcedure', () => {
  it('produces DECLARE, SET, RETURN NEW for a simple before-row body', () => {
    const proc = defineProcedure(
      { name: 'trg_simple_fn' },
      [],
      { score: 'integer' },
      ({ db }) => {
        db.set(db.var.score!, sql.raw('10'))
        // db.NEW is a Proxy and cannot be passed directly to db.return(); use a
        // raw SqlFragment instead to produce "RETURN NEW"
        db.return(sql.raw('NEW'))
      },
    )

    const output = compileAll([proc])

    expect(output).toContain('DECLARE')
    expect(output).toContain('score := 10')
    expect(output).toContain('RETURN NEW')
  })

  it('simple set + return NEW column fragment appears in output', () => {
    const proc = defineProcedure(
      { name: 'trg_new_col_fn' },
      [],
      {},
      ({ db }) => {
        db.set(db.NEW.score!, sql.raw('42'))
        db.return(db.NEW.score!)
      },
    )

    const output = compileAll([proc])

    expect(output).toContain('NEW."score" := 42')
    expect(output).toContain('RETURN NEW."score"')
  })

  // -------------------------------------------------------------------------
  // 2. db.if with else
  // -------------------------------------------------------------------------
  it('compiles db.if with else to IF...THEN...ELSE...END IF', () => {
    const proc = makeProc('trg_if_fn', ({ db }) => {
      db.if(
        sql.raw('NEW."active" IS TRUE'),
        () => {
          db.set('result', sql.raw("'yes'"))
        },
        () => {
          db.set('result', sql.raw("'no'"))
        },
      )
      db.return(db.NEW.id)
    })

    const output = compileAll([proc])

    expect(output).toContain('IF NEW."active" IS TRUE THEN')
    expect(output).toContain("result := 'yes'")
    expect(output).toContain('ELSE')
    expect(output).toContain("result := 'no'")
    expect(output).toContain('END IF')
  })

  // -------------------------------------------------------------------------
  // 3. db.switch with two cases and _else
  // -------------------------------------------------------------------------
  it('compiles db.switch with two cases and _else to CASE...WHEN...ELSE...END CASE', () => {
    const proc = makeProc('trg_switch_fn', ({ db }) => {
      db.switch(db.NEW.status!, {
        active: () => {
          db.set('flag', sql.raw('1'))
        },
        inactive: () => {
          db.set('flag', sql.raw('0'))
        },
        _else: () => {
          db.set('flag', sql.raw('-1'))
        },
      })
      db.return(db.NEW.id)
    })

    const output = compileAll([proc])

    expect(output).toContain('CASE NEW."status"')
    expect(output).toContain("WHEN 'active' THEN")
    expect(output).toContain("WHEN 'inactive' THEN")
    expect(output).toContain('ELSE')
    expect(output).toContain('END CASE')
  })

  // -------------------------------------------------------------------------
  // 4. db.catch hoisted to EXCEPTION section regardless of position in body
  // -------------------------------------------------------------------------
  it('hoists db.catch to the EXCEPTION section regardless of its position in the body', () => {
    const proc = makeProc('trg_catch_fn', ({ db }) => {
      db.set('x', sql.raw('1'))
      // catch in the middle of the body
      db.catch({
        unique_violation: () => {
          db.return(sql.raw('NULL'))
        },
      })
      db.set('y', sql.raw('2'))
      db.return(db.NEW.id)
    })

    const output = compileAll([proc])

    // EXCEPTION section must appear after the body
    const exceptionIdx = output.indexOf('EXCEPTION')
    const endIdx = output.indexOf('END;')

    expect(exceptionIdx).toBeGreaterThan(-1)
    expect(endIdx).toBeGreaterThan(exceptionIdx)
    expect(output).toContain('WHEN unique_violation THEN')

    // The catch block itself must NOT appear verbatim in the body (it is hoisted)
    // The catch statement is filtered from body by filterBody — only EXCEPTION section contains it
    const bodyPart = output.slice(0, exceptionIdx)
    expect(bodyPart).not.toContain('WHEN unique_violation')
  })

  // -------------------------------------------------------------------------
  // 5. Procedure with one temp table
  // -------------------------------------------------------------------------
  it('includes CREATE TEMP TABLE, _proc_instance_id in DECLARE and DELETE cleanup before RETURN', () => {
    const myTable = defineTempTable('proc_items', { label: 'text', amount: 'integer' })

    const proc = defineProcedure(
      { name: 'trg_temp_fn' },
      [myTable],
      {},
      ({ db }) => {
        db.return(db.NEW.id)
      },
    )

    const output = compileAll([proc])

    expect(output).toContain('CREATE TEMP TABLE IF NOT EXISTS "proc_items"')
    expect(output).toContain('_proc_instance_id')
    // The DECLARE section should declare _proc_instance_id
    expect(output).toContain('_proc_instance_id UUID := gen_random_uuid()')
    // Cleanup DELETE must appear before RETURN
    const deleteIdx = output.indexOf('DELETE FROM "proc_items"')
    const returnIdx = output.indexOf('RETURN NEW."id"')
    expect(deleteIdx).toBeGreaterThan(-1)
    expect(returnIdx).toBeGreaterThan(deleteIdx)
  })

  // -------------------------------------------------------------------------
  // 6. db.selectFrom().into()
  // -------------------------------------------------------------------------
  it('compiles db.selectFrom().into() to SELECT...INTO...FROM pattern', () => {
    const proc = defineProcedure(
      { name: 'trg_select_into_fn' },
      [],
      { v_score: 'integer' },
      ({ db, sql: s }) => {
        // selectFrom delegates to Kysely's builder, so use a string column name
        // (Kysely's .select() does not accept raw SqlFragments)
        db.selectFrom('scoring')
          .select('score')
          .into({ v_score: s.raw('score') })
        db.return(db.NEW.id)
      },
    )

    const output = compileAll([proc])

    // extractFromClause strips everything up to and including "from", so the
    // compiled selectInto output is: SELECT score\nINTO v_score\n"scoring"
    expect(output).toContain('SELECT score')
    expect(output).toContain('INTO v_score')
    // The from-clause fragment (table ref) must appear after INTO
    const intoIdx = output.indexOf('INTO v_score')
    const tableIdx = output.indexOf('"scoring"')
    expect(intoIdx).toBeGreaterThan(-1)
    expect(tableIdx).toBeGreaterThan(intoIdx)
  })

  // -------------------------------------------------------------------------
  // 7. compileTrigger with STATEMENT, REFERENCING new and old, WHEN clause
  // -------------------------------------------------------------------------
  it('compileTrigger includes REFERENCING, FOR EACH STATEMENT and WHEN clause', () => {
    const proc = makeProc('trg_stmt_fn', ({ db }) => {
      db.return(db.NEW.id)
    })

    const trigger = defineTrigger(
      {
        name: 'trg_stmt',
        table: 'orders',
        timing: 'AFTER',
        events: ['INSERT', 'UPDATE'],
        forEach: 'STATEMENT',
        referencing: { old: 'old_rows', new: 'new_rows' },
        when: sql.raw('pg_trigger_depth() = 0'),
      },
      proc,
    )

    const output = compileTrigger(trigger)

    expect(output).toContain('FOR EACH STATEMENT')
    expect(output).toContain('REFERENCING')
    expect(output).toContain('OLD TABLE AS old_rows')
    expect(output).toContain('NEW TABLE AS new_rows')
    expect(output).toContain('WHEN (pg_trigger_depth() = 0)')
    expect(output).toContain('"orders"')
    expect(output).toContain('INSERT OR UPDATE')
  })

  // -------------------------------------------------------------------------
  // 8. compileAll with one trigger: procedure appears before trigger, header comment
  // -------------------------------------------------------------------------
  it('compileAll places procedure before its trigger and includes the header comment', () => {
    const proc = makeProc('trg_order_fn', ({ db }) => {
      db.return(db.NEW.id)
    })

    const trigger = defineTrigger(
      {
        name: 'trg_order',
        table: 'orders',
        timing: 'BEFORE',
        events: ['INSERT'],
        forEach: 'ROW',
      },
      proc,
    )

    const output = compileAll([trigger])

    expect(output).toContain('-- Generated by @mesalia/kysely-pg-procedures')
    expect(output).toContain('-- DO NOT EDIT MANUALLY')

    const procIdx = output.indexOf('CREATE OR REPLACE FUNCTION trg_order_fn')
    const trgIdx = output.indexOf('CREATE OR REPLACE TRIGGER trg_order')

    expect(procIdx).toBeGreaterThan(-1)
    expect(trgIdx).toBeGreaterThan(-1)
    expect(procIdx).toBeLessThan(trgIdx)
  })
})
