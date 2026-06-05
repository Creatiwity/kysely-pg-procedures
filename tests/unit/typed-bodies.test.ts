import { describe, it, expect } from 'vitest'
import { compileProcedure } from '../../src/compiler.js'
import { defineProcedure } from '../../src/procedure.js'
import { sql } from '../../src/sql.js'
import { sql as ksql } from 'kysely'

describe('typed procedure bodies — round 3', () => {
  // -------------------------------------------------------------------------
  // Test 1: parameter inlining — boolean literal
  // -------------------------------------------------------------------------
  it('inlines boolean literal — no $1 placeholder', () => {
    const proc = defineProcedure(
      { name: 'test_bool_inline', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.execute(db.deleteFrom('conversations').where('is_ephemeral', '=', true))
      },
    )

    const output = compileProcedure(proc)

    expect(output).toMatch(/"is_ephemeral"\s*=\s*TRUE/i)
    expect(output).not.toContain('$1')
  })

  // -------------------------------------------------------------------------
  // Test 2: parameter inlining — number
  // -------------------------------------------------------------------------
  it('inlines number literal — no $1 placeholder', () => {
    const proc = defineProcedure(
      { name: 'test_num_inline', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.execute(db.selectFrom('messages').selectAll().where('score', '>', 42))
      },
    )

    const output = compileProcedure(proc)

    expect(output).toContain('42')
    expect(output).not.toContain('$1')
  })

  // -------------------------------------------------------------------------
  // Test 3: forRow emits FOR … IN … LOOP / END LOOP
  // -------------------------------------------------------------------------
  it('forRow emits FOR rowVar IN query LOOP … END LOOP', () => {
    const proc = defineProcedure(
      { name: 'test_for_row', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.forRow(db.selectFrom('items').selectAll(), (row) => {
          db.raise('NOTICE', 'found item')
        })
      },
    )

    const output = compileProcedure(proc)

    expect(output).toContain('FOR _kpp_row0 IN')
    expect(output).toContain('LOOP')
    expect(output).toContain('END LOOP')
  })

  // -------------------------------------------------------------------------
  // Test 3b: forRow yields a typed row proxy
  // -------------------------------------------------------------------------
  it('forRow yields a typed row proxy — column access compiles to rowVar."col"', () => {
    const proc = defineProcedure(
      { name: 'fn_typed_row', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.forRow(db.selectFrom('items' as any).selectAll(), (row: any) => {
          db.raise('NOTICE', 'row id', { args: [row.id] })
        })
      },
    )
    const out = compileProcedure(proc)
    expect(out).toMatch(/_kpp_row0."id"/)
  })

  // -------------------------------------------------------------------------
  // Test 4: forIn emits FOR var IN from..to LOOP
  // -------------------------------------------------------------------------
  it('forIn emits FOR i IN 1..10 LOOP', () => {
    const proc = defineProcedure(
      { name: 'test_for_in', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.forIn('i', 1, 10, () => {
          db.raise('NOTICE', 'tick')
        })
      },
    )

    const output = compileProcedure(proc)

    expect(output).toContain('FOR i IN 1..10 LOOP')
  })

  // -------------------------------------------------------------------------
  // Test 5: while loop
  // -------------------------------------------------------------------------
  it('while emits WHILE condition LOOP … END LOOP', () => {
    const proc = defineProcedure(
      { name: 'test_while', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.while(sql.raw('counter > 0'), () => {
          db.raise('NOTICE', 'looping')
        })
      },
    )

    const output = compileProcedure(proc)

    expect(output).toContain('WHILE counter > 0 LOOP')
  })

  // -------------------------------------------------------------------------
  // Test 6: loop + exit
  // -------------------------------------------------------------------------
  it('loop with exit emits LOOP … EXIT WHEN … END LOOP', () => {
    const proc = defineProcedure(
      { name: 'test_loop_exit', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.loop(() => {
          db.exit(sql.raw('done'))
        })
      },
    )

    const output = compileProcedure(proc)

    expect(output).toContain('LOOP')
    expect(output).toContain('EXIT WHEN done')
  })

  // -------------------------------------------------------------------------
  // Test 7: continue
  // -------------------------------------------------------------------------
  it('continue emits CONTINUE WHEN condition', () => {
    const proc = defineProcedure(
      { name: 'test_continue', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.loop(() => {
          db.continue(sql.raw('FOUND'))
          db.raise('NOTICE', 'continued')
        })
      },
    )

    const output = compileProcedure(proc)

    expect(output).toContain('CONTINUE WHEN FOUND')
  })

  // -------------------------------------------------------------------------
  // Test 8: FOUND accessor compiles to IF FOUND THEN
  // -------------------------------------------------------------------------
  it('db.FOUND compiles to the FOUND identifier in IF condition', () => {
    const proc = defineProcedure(
      { name: 'test_found', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.if(db.FOUND, () => {
          db.raise('NOTICE', 'found')
        })
      },
    )

    const output = compileProcedure(proc)

    expect(output).toContain('IF FOUND THEN')
  })

  // -------------------------------------------------------------------------
  // Test 9: raise with errcode emits USING clause
  // -------------------------------------------------------------------------
  it('raise with errcode and hint emits USING ERRCODE and HINT clauses', () => {
    const proc = defineProcedure(
      { name: 'test_raise_using', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.raise('EXCEPTION', 'not allowed', { errcode: '42501', hint: 'Check your permissions' })
      },
    )

    const output = compileProcedure(proc)

    expect(output).toContain("RAISE EXCEPTION 'not allowed'")
    expect(output).toContain("ERRCODE = '42501'")
    expect(output).toContain("HINT = 'Check your permissions'")
  })

  // -------------------------------------------------------------------------
  // Test 10: raise without opts — backward compatible, no USING clause
  // -------------------------------------------------------------------------
  it('raise without opts emits no USING clause', () => {
    const proc = defineProcedure(
      { name: 'test_raise_no_using', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.raise('WARNING', 'heads up')
      },
    )

    const output = compileProcedure(proc)

    expect(output).toContain("RAISE WARNING 'heads up'")
    expect(output).not.toContain('USING')
  })

  // -------------------------------------------------------------------------
  // Test A: forRow loop variable is declared as RECORD in DECLARE block
  // -------------------------------------------------------------------------
  it('forRow loop variable is declared as RECORD in DECLARE block', () => {
    const proc = defineProcedure(
      { name: 'test_forrow_declare', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.forRow(db.selectFrom('items' as any).selectAll(), (_row) => {
          db.raise('NOTICE', 'item found')
        })
      },
    )

    const output = compileProcedure(proc)

    expect(output).toContain('_kpp_row0 RECORD')
  })

  // -------------------------------------------------------------------------
  // Test B: db.if accepts a Kysely Expression (ksql) as condition
  // -------------------------------------------------------------------------
  it('db.if accepts a Kysely Expression (ksql) as condition', () => {
    const proc = defineProcedure(
      { name: 'test_if_kysely_expr', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.if(ksql`active = TRUE` as any, () => {
          db.raise('NOTICE', 'active')
        })
      },
    )

    const output = compileProcedure(proc)

    expect(output).not.toContain('undefined')
    expect(output).toContain('active = TRUE')
  })

  // -------------------------------------------------------------------------
  // Test C: db.set accepts a Kysely Expression (ksql) as value
  // -------------------------------------------------------------------------
  it('db.set accepts a Kysely Expression (ksql) as value', () => {
    const proc = defineProcedure(
      { name: 'test_set_kysely_expr', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.set('my_var', ksql`42 + 1` as any)
      },
    )

    const output = compileProcedure(proc)

    expect(output).not.toContain('undefined')
  })
})
