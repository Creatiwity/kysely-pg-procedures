import { describe, it, expect } from 'vitest'
import {
  defineSessionVars,
  enableRls,
  definePolicy,
  compileRlsEnable,
  compilePolicyBlock,
  compileAll,
  defineProcedure,
  defineTrigger,
  sql,
} from '../../src/index.js'

type DB = {
  items:  { id: string; org_id: string; user_id: string; name: string; score: number; deleted_at: Date | null }
  orders: { id: string; tenant_id: string; amount: number }
}

// ---------------------------------------------------------------------------
// enableRls
// ---------------------------------------------------------------------------
describe('enableRls', () => {
  it('compiles to ALTER TABLE ENABLE ROW LEVEL SECURITY', () => {
    const output = compileRlsEnable(enableRls<DB>()('items'))
    expect(output).toContain('ALTER TABLE "items" ENABLE ROW LEVEL SECURITY')
    expect(output).not.toContain('FORCE')
  })

  it('with force: true adds FORCE ROW LEVEL SECURITY', () => {
    const output = compileRlsEnable(enableRls<DB>()('items', { force: true }))
    expect(output).toContain('ALTER TABLE "items" ENABLE ROW LEVEL SECURITY')
    expect(output).toContain('ALTER TABLE "items" FORCE ROW LEVEL SECURITY')
  })

  it('sets _tag, table, force', () => {
    const def = enableRls<DB>()('orders')
    expect(def._tag).toBe('RlsEnable')
    expect(def.table).toBe('orders')
    expect(def.force).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// definePolicy — Kysely ExpressionBuilder (primary API)
// ---------------------------------------------------------------------------
describe('definePolicy — Kysely eb API', () => {
  it('simple equality produces correct USING SQL', () => {
    const s = defineSessionVars({ orgId: 'uuid' })
    const p = definePolicy<DB>()('items', { name: 'p' }, s, ({ eb, session }) => ({
      using: eb('org_id', '=', session.orgId),
    }))
    const output = compilePolicyBlock(p)
    expect(output).toContain('USING (')
    expect(output).toContain('"org_id"')
    expect(output).toContain("current_setting('app.orgId', true)::uuid")
  })

  it('eb.and combines multiple conditions', () => {
    const s = defineSessionVars({ orgId: 'uuid' })
    const p = definePolicy<DB>()('items', { name: 'p_and' }, s, ({ eb, session }) => ({
      using: eb.and([
        eb('org_id', '=', session.orgId),
        eb('deleted_at', 'is', null),
      ]),
    }))
    const output = compilePolicyBlock(p)
    expect(output).toContain('"org_id"')
    expect(output).toContain('"deleted_at"')
    expect(output).toContain('is null')
  })

  it('eb.or combines conditions with OR', () => {
    const s = defineSessionVars({ orgId: 'uuid', userId: 'uuid' })
    const p = definePolicy<DB>()('items', { name: 'p_or' }, s, ({ eb, session }) => ({
      using: eb.or([
        eb('org_id', '=', session.orgId),
        eb('user_id', '=', session.userId),
      ]),
    }))
    const output = compilePolicyBlock(p)
    expect(output).toContain('"org_id"')
    expect(output).toContain('"user_id"')
  })

  it('session variable compiles with correct type cast', () => {
    const s = defineSessionVars({ tenantId: 'text', userId: 'uuid' })
    const p = definePolicy<DB>()('items', { name: 'p_session' }, s, ({ eb, session }) => ({
      using: eb.and([
        eb('org_id', '=', session.tenantId),
        eb('user_id', '=', session.userId),
      ]),
    }))
    const output = compilePolicyBlock(p)
    expect(output).toContain("current_setting('app.tenantId', true)::text")
    expect(output).toContain("current_setting('app.userId', true)::uuid")
  })

  it('null sessionVarsDef works for policies without session context', () => {
    const p = definePolicy<DB>()('items', { name: 'p_nosession' }, null, ({ eb }) => ({
      using: eb('score', '>', 0),
    }))
    const output = compilePolicyBlock(p)
    expect(output).toContain('USING (')
    expect(output).toContain('"score"')
  })
})

// ---------------------------------------------------------------------------
// definePolicy — opts
// ---------------------------------------------------------------------------
describe('definePolicy — opts', () => {
  it('PERMISSIVE appears in compiled output', () => {
    const p = definePolicy<DB>()('items', { name: 'p', as: 'PERMISSIVE', command: 'ALL' }, null,
      ({ eb }) => ({ using: eb('score', '>', 0) }))
    expect(compilePolicyBlock(p)).toContain('AS PERMISSIVE')
  })

  it('RESTRICTIVE appears in compiled output', () => {
    const p = definePolicy<DB>()('items', { name: 'p', as: 'RESTRICTIVE', command: 'SELECT' }, null,
      ({ eb }) => ({ using: eb('score', '>', 0) }))
    expect(compilePolicyBlock(p)).toContain('AS RESTRICTIVE')
  })

  it('FOR SELECT', () => {
    const p = definePolicy<DB>()('items', { name: 'p', command: 'SELECT' }, null,
      ({ eb }) => ({ using: eb('score', '>', 0) }))
    expect(compilePolicyBlock(p)).toContain('FOR SELECT')
  })

  it('FOR INSERT with withCheck only', () => {
    const s = defineSessionVars({ orgId: 'uuid' })
    const p = definePolicy<DB>()('items', { name: 'p', command: 'INSERT' }, s,
      ({ eb, session }) => ({ withCheck: eb('org_id', '=', session.orgId) }))
    const output = compilePolicyBlock(p)
    expect(output).toContain('FOR INSERT')
    expect(output).toContain('WITH CHECK (')
    expect(output).not.toContain('USING')
  })

  it('FOR UPDATE with both USING and WITH CHECK', () => {
    const s = defineSessionVars({ orgId: 'uuid' })
    const p = definePolicy<DB>()('items', { name: 'p', command: 'UPDATE' }, s, ({ eb, session }) => ({
      using:     eb('org_id', '=', session.orgId),
      withCheck: eb('org_id', '=', session.orgId),
    }))
    const output = compilePolicyBlock(p)
    expect(output).toContain('FOR UPDATE')
    expect(output).toContain('USING (')
    expect(output).toContain('WITH CHECK (')
  })

  it('single role → TO <role>', () => {
    const p = definePolicy<DB>()('items', { name: 'p', roles: ['app_user'] }, null,
      ({ eb }) => ({ using: eb('score', '>', 0) }))
    expect(compilePolicyBlock(p)).toContain('TO app_user')
  })

  it('multiple roles → comma-separated', () => {
    const p = definePolicy<DB>()('items', { name: 'p', roles: ['app_user', 'app_admin'] }, null,
      ({ eb }) => ({ using: eb('score', '>', 0) }))
    expect(compilePolicyBlock(p)).toContain('TO app_user, app_admin')
  })

  it('omitting roles does not emit TO clause', () => {
    const p = definePolicy<DB>()('items', { name: 'p' }, null, ({ eb }) => ({ using: eb('score', '>', 0) }))
    expect(compilePolicyBlock(p)).not.toContain(' TO ')
  })

  it('omitting as does not emit AS clause', () => {
    const p = definePolicy<DB>()('items', { name: 'p' }, null, ({ eb }) => ({ using: eb('score', '>', 0) }))
    const output = compilePolicyBlock(p)
    expect(output).not.toContain('AS PERMISSIVE')
    expect(output).not.toContain('AS RESTRICTIVE')
  })
})

// ---------------------------------------------------------------------------
// DROP IF EXISTS + CREATE (no CREATE OR REPLACE, pre-PG17)
// ---------------------------------------------------------------------------
describe('definePolicy — DROP IF EXISTS + CREATE pattern', () => {
  it('DROP appears before CREATE', () => {
    const p = definePolicy<DB>()('items', { name: 'my_policy' }, null, ({ eb }) => ({ using: eb('score', '>', 0) }))
    const output = compilePolicyBlock(p)
    const dropIdx   = output.indexOf('DROP POLICY IF EXISTS "my_policy"')
    const createIdx = output.indexOf('CREATE POLICY "my_policy"')
    expect(dropIdx).toBeGreaterThan(-1)
    expect(createIdx).toBeGreaterThan(dropIdx)
  })

  it('does NOT use CREATE OR REPLACE POLICY', () => {
    const p = definePolicy<DB>()('items', { name: 'p' }, null, ({ eb }) => ({ using: eb('score', '>', 0) }))
    expect(compilePolicyBlock(p)).not.toContain('CREATE OR REPLACE POLICY')
  })
})

// ---------------------------------------------------------------------------
// compileAll ordering
// ---------------------------------------------------------------------------
describe('compileAll — ordering with RLS', () => {
  it('RLS enable → policies → procedures → triggers', () => {
    const rlsDef = enableRls<DB>()('items')
    const s = defineSessionVars({ orgId: 'uuid' })
    const policy = definePolicy<DB>()('items', { name: 'items_policy', command: 'ALL' }, s,
      ({ eb, session }) => ({ using: eb('org_id', '=', session.orgId) }))
    const proc = defineProcedure({ name: 'fn_items' }, [], {}, ({ db }) => { db.return(sql.raw('NEW')) })
    const trigger = defineTrigger({ name: 'trg_items', table: 'items', timing: 'BEFORE', events: ['INSERT'], forEach: 'ROW' }, proc)

    const output = compileAll([rlsDef, policy, proc, trigger])

    const rlsIdx     = output.indexOf('ALTER TABLE "items" ENABLE ROW LEVEL SECURITY')
    const policyIdx  = output.indexOf('CREATE POLICY "items_policy"')
    const procIdx    = output.indexOf('CREATE OR REPLACE FUNCTION fn_items')
    const triggerIdx = output.indexOf('CREATE OR REPLACE TRIGGER trg_items')

    expect(rlsIdx).toBeGreaterThan(-1)
    expect(policyIdx).toBeGreaterThan(rlsIdx)
    expect(procIdx).toBeGreaterThan(policyIdx)
    expect(triggerIdx).toBeGreaterThan(procIdx)
  })

  it('compileAll with only RLS still emits header', () => {
    const output = compileAll([enableRls<DB>()('orders', { force: true })])
    expect(output).toContain('-- Generated by')
    expect(output).toContain('ALTER TABLE "orders" FORCE ROW LEVEL SECURITY')
  })
})
