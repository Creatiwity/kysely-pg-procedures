import { describe, it, expect } from 'vitest'
import { compileProcedure } from '../../src/compiler.js'
import { defineProcedure } from '../../src/procedure.js'
import { sql } from '../../src/sql.js'
import { sql as ksql } from 'kysely'
// jsonBuildObject is not a named export from kysely; define a local stand-in
// that returns a real Kysely Expression (ksql tagged template) so we can test
// that proxy ColumnRefs inside Kysely Expressions compile correctly.
function jsonBuildObject(obj: Record<string, unknown>): ReturnType<typeof ksql> {
  const parts: unknown[] = []
  const keys = Object.keys(obj)
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) parts.push(ksql.raw(', '))
    parts.push(ksql.raw(`'${keys[i]}', `))
    parts.push(obj[keys[i]])
  }
  return ksql`json_build_object(${ksql.join(Object.entries(obj).map(([k, v]) => ksql`${ksql.raw(`'${k}'`)}, ${v as any}`))})`
}

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

  // -------------------------------------------------------------------------
  // R5.1: proxy as Kysely Expression (no [object Object])
  // -------------------------------------------------------------------------
  it('R5.1: proxy as Kysely Expression — db.return(jsonBuildObject) contains v_n, not [object Object]', () => {
    const proc = defineProcedure(
      { name: 'test_proxy_expression', returns: 'void', language: 'plpgsql' },
      [],
      { v_n: 'integer' },
      ({ db }) => {
        db.return(jsonBuildObject({ n: db.var.v_n }) as any)
      },
    )

    const output = compileProcedure(proc)

    expect(output).not.toContain('[object Object]')
    expect(output).toContain('v_n')
  })

  // -------------------------------------------------------------------------
  // R5.1: ksql template with proxy (no [object Object])
  // -------------------------------------------------------------------------
  it('R5.1: ksql template with proxy — db.execute(ksql`...${db.var.v_n}`) contains v_n, not [object Object]', () => {
    const proc = defineProcedure(
      { name: 'test_ksql_proxy', returns: 'void', language: 'plpgsql' },
      [],
      { v_n: 'integer' },
      ({ db }) => {
        db.execute(ksql`update t set x = ${db.var.v_n as any}`)
      },
    )

    const output = compileProcedure(proc)

    expect(output).not.toContain('[object Object]')
    expect(output).toContain('v_n')
  })

  // -------------------------------------------------------------------------
  // R5.2: dmlInto from insertInto with returning
  // -------------------------------------------------------------------------
  it('R5.2: dmlInto — insertInto with returning compiles to INSERT INTO … INTO v_id', () => {
    const proc = defineProcedure(
      { name: 'test_dml_into', returns: 'void', language: 'plpgsql' },
      [],
      { v_id: 'integer' },
      ({ db }) => {
        db.insertInto('items' as any)
          .values({ name: 'x' } as any)
          .returning('id' as any)
          .into({ v_id: sql.raw('id') })
      },
    )

    const output = compileProcedure(proc)

    expect(output).toMatch(/insert into/i)
    expect(output).toContain('INTO v_id')
  })

  // -------------------------------------------------------------------------
  // R5.3: intoRow on selectFrom
  // -------------------------------------------------------------------------
  it('R5.3: intoRow — selectFrom with where compiles to SELECT * INTO v_msg', () => {
    const proc = defineProcedure(
      { name: 'test_into_row', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.selectFrom('messages' as any)
          .where('id', '=', 1 as any)
          .intoRow('v_msg')
      },
    )

    const output = compileProcedure(proc)

    expect(output).toContain('SELECT *')
    expect(output).toContain('INTO v_msg')
  })

  // -------------------------------------------------------------------------
  // R6.1: returnQuery emits RETURN QUERY with the full query text
  // -------------------------------------------------------------------------
  it('R6.1: returnQuery — emits RETURN QUERY and references the table', () => {
    const proc = defineProcedure(
      { name: 'test_return_query', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.returnQuery(db.selectFrom('profiles' as any).selectAll())
      },
    )

    const output = compileProcedure(proc)

    expect(output).toMatch(/RETURN QUERY/i)
    expect(output).toContain('profiles')
  })

  // -------------------------------------------------------------------------
  // R6.2: intoRecord preserves explicit column list, not SELECT *
  // -------------------------------------------------------------------------
  it('R6.2: intoRecord — emits INTO v_conv and preserves explicit column list', () => {
    const proc = defineProcedure(
      { name: 'test_into_record', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.selectFrom('conversations as c' as any)
          .select(['c.kind' as any])
          .where('c.id', '=', 1 as any)
          .intoRecord('v_conv')
      },
    )

    const output = compileProcedure(proc)

    expect(output).toContain('INTO v_conv')
    expect(output).not.toContain('SELECT *')
  })

  // -------------------------------------------------------------------------
  // R6.3: named forRow uses supplied variable name, not auto-generated one
  // -------------------------------------------------------------------------
  it('R6.3: named forRow — emits FOR v_member IN and does not use _kpp_row', () => {
    const proc = defineProcedure(
      { name: 'test_named_for_row', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.forRow('v_member', db.selectFrom('members' as any).selectAll(), (_row: any) => {
          db.raise('NOTICE', 'ok')
        })
      },
    )

    const output = compileProcedure(proc)

    expect(output).toContain('FOR v_member IN')
    expect(output).not.toContain('_kpp_row')
  })

  // -------------------------------------------------------------------------
  // R6.3: forEach emits FOREACH … IN ARRAY … LOOP
  // -------------------------------------------------------------------------
  it('R6.3: forEach — emits FOREACH v_opt IN ARRAY v_options LOOP', () => {
    const proc = defineProcedure(
      { name: 'test_foreach', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.forEach('v_opt', sql.raw('v_options'), () => {
          db.raise('NOTICE', 'tick')
        })
      },
    )

    const output = compileProcedure(proc)

    expect(output).toContain('FOREACH v_opt IN ARRAY v_options LOOP')
  })

  // -------------------------------------------------------------------------
  // R6.4: intoRow with subquery in WHERE — outer FROM is preserved
  // -------------------------------------------------------------------------
  it('R6.4: intoRow with subquery in WHERE — outer table is messages, INTO v_msg', () => {
    const proc = defineProcedure(
      { name: 'test_into_row_subquery', returns: 'void', language: 'plpgsql' },
      [],
      {},
      ({ db }) => {
        db.selectFrom('messages as m' as any)
          .where(ksql`m.id > 0 AND NOT EXISTS (SELECT 1 FROM deleted d WHERE d.msg_id = m.id)` as any)
          .intoRow('v_msg')
      },
    )

    const output = compileProcedure(proc)

    expect(output).toMatch(/FROM "messages"/)
    expect(output).toContain('INTO v_msg')
    // The primary FROM (outer table) must not be 'deleted'
    const afterInto = output.slice(output.indexOf('INTO v_msg'))
    expect(afterInto).not.toMatch(/^\s*FROM deleted/m)
  })
})
