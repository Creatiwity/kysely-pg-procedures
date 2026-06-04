import { describe, it, expect } from 'vitest'
import { compileProcedure } from '../src/compiler.js'
import { defineProcedure } from '../src/procedure.js'

describe('rawBody', () => {
  // 1. rawBody with LANGUAGE sql emits valid SQL — no BEGIN/END
  it('LANGUAGE sql with rawBody omits BEGIN/END and emits body verbatim', () => {
    const proc = defineProcedure(
      { name: 'fn_sql_raw', language: 'sql', returns: 'integer', rawBody: '  select 1;' },
      [],
      {},
      () => {},
    )
    const output = compileProcedure(proc)
    expect(output).not.toContain('BEGIN')
    expect(output).not.toContain('END;')
    expect(output).toContain('select 1;')
    expect(output).toContain('LANGUAGE sql')
  })

  // 2. Dollar-quote defaults to $$
  it('wraps rawBody in $$ when body does not contain $$', () => {
    const proc = defineProcedure(
      { name: 'fn_default_tag', returns: 'void', rawBody: 'SELECT 1;' },
      [],
      {},
      () => {},
    )
    const output = compileProcedure(proc)
    expect(output).toContain('AS $$')
  })

  // 3. Dollar-quote collision: body contains $$ → compiler picks non-colliding tag
  it('picks a non-colliding tag when rawBody contains $$', () => {
    const proc = defineProcedure(
      { name: 'fn_collision', returns: 'void', rawBody: 'SELECT $$ AS x;' },
      [],
      {},
      () => {},
    )
    const output = compileProcedure(proc)
    expect(output).not.toMatch(/AS \$\$\n/)
    expect(output).toContain('$kpp$')
    expect(output).toContain('SELECT $$ AS x;')
  })

  // 4. Explicit bodyTag is honored
  it('uses the explicit bodyTag when provided', () => {
    const proc = defineProcedure(
      { name: 'fn_explicit_tag', returns: 'void', rawBody: 'SELECT 1;', bodyTag: '$function$' },
      [],
      {},
      () => {},
    )
    const output = compileProcedure(proc)
    expect(output).toContain('AS $function$')
  })

  // 5. rawBody respects args, set, volatility, security
  it('emits SECURITY DEFINER, SET clause, and arg list from definition', () => {
    const proc = defineProcedure(
      {
        name: 'fn_with_opts',
        returns: 'void',
        args: [{ name: 'p_id', type: 'uuid' }],
        set: { search_path: 'public, pg_temp' },
        security: 'DEFINER',
        rawBody: 'SELECT p_id;',
      },
      [],
      {},
      () => {},
    )
    const output = compileProcedure(proc)
    expect(output).toContain('SECURITY DEFINER')
    expect(output).toContain('SET search_path = public, pg_temp')
    expect(output).toContain('p_id uuid')
  })

  // 6. rawBody triggers onWarn
  it('calls onWarn when rawBody is used', () => {
    const warnings: string[] = []
    const proc = defineProcedure(
      { name: 'fn_warn_raw', returns: 'void', rawBody: 'SELECT 1;' },
      [],
      {},
      () => {},
    )
    compileProcedure(proc, { onWarn: (msg) => warnings.push(msg) })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('rawBody')
  })

  // 7. raw VarDecl triggers onWarn
  it('calls onWarn when a var uses a raw type', () => {
    const warnings: string[] = []
    const proc = defineProcedure(
      { name: 'fn_warn_var', returns: 'void' },
      [],
      { v_msg: { raw: 'public.messages%rowtype' } },
      () => {},
    )
    compileProcedure(proc, { onWarn: (msg) => warnings.push(msg) })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('v_msg')
    expect(warnings[0]).toContain('public.messages%rowtype')
  })

  // 8. Normal procedure produces NO warnings
  it('emits no warnings for a normal procedure without rawBody or raw vars', () => {
    const warnings: string[] = []
    const proc = defineProcedure(
      { name: 'fn_no_warn', returns: 'void', args: [{ name: 'p_name', type: 'text' }] },
      [],
      { v_count: 'integer' },
      ({ db, sql }) => {
        db.return(sql.raw('NULL'))
      },
    )
    compileProcedure(proc, { onWarn: (msg) => warnings.push(msg) })
    expect(warnings).toHaveLength(0)
  })
})
