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

// ---------------------------------------------------------------------------
// Test DB schema for type-checked tests
// ---------------------------------------------------------------------------
type DB = {
  items: { id: string; org_id: string; user_id: string; name: string; score: number }
  orders: { id: string; tenant_id: string; amount: number }
}

// ---------------------------------------------------------------------------
// 1. enableRls — basic ENABLE ROW LEVEL SECURITY
// ---------------------------------------------------------------------------
describe('enableRls', () => {
  it('compiles to ALTER TABLE ENABLE ROW LEVEL SECURITY', () => {
    const def = enableRls<DB>()('items')
    const output = compileRlsEnable(def)

    expect(output).toContain('ALTER TABLE "items" ENABLE ROW LEVEL SECURITY')
    expect(output).not.toContain('FORCE')
  })

  it('with force: true adds FORCE ROW LEVEL SECURITY', () => {
    const def = enableRls<DB>()('items', { force: true })
    const output = compileRlsEnable(def)

    expect(output).toContain('ALTER TABLE "items" ENABLE ROW LEVEL SECURITY')
    expect(output).toContain('ALTER TABLE "items" FORCE ROW LEVEL SECURITY')
  })

  it('without force option does not emit FORCE', () => {
    const def = enableRls<DB>()('orders', { force: false })
    const output = compileRlsEnable(def)

    expect(output).toContain('ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY')
    expect(output).not.toContain('FORCE')
  })

  it('sets _tag to RlsEnable', () => {
    const def = enableRls<DB>()('items')
    expect(def._tag).toBe('RlsEnable')
    expect(def.table).toBe('items')
    expect(def.force).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. definePolicy — basic USING clause
// ---------------------------------------------------------------------------
describe('definePolicy — basic USING clause', () => {
  it('compiles to correct CREATE POLICY SQL with USING', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_select_policy', command: 'SELECT' },
      null,
      {
        using: ({ sql: s }) => s.raw('true'),
      },
    )

    const output = compilePolicyBlock(policy)

    expect(output).toContain('DROP POLICY IF EXISTS "items_select_policy" ON "items"')
    expect(output).toContain('CREATE POLICY "items_select_policy" ON "items"')
    expect(output).toContain('FOR SELECT')
    expect(output).toContain('USING (true)')
  })

  it('col.columnName produces correct column reference', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_col_test' },
      null,
      {
        using: ({ col, sql: s }) => s.raw(`${col.org_id.text} IS NOT NULL`),
      },
    )

    const output = compilePolicyBlock(policy)

    expect(output).toContain('"org_id"')
    expect(output).toContain('USING ("org_id" IS NOT NULL)')
  })
})

// ---------------------------------------------------------------------------
// 3. defineSessionVars + session proxy
// ---------------------------------------------------------------------------
describe('defineSessionVars + session proxy', () => {
  it('session.varName compiles to current_setting with correct type cast', () => {
    const sessionVars = defineSessionVars({ userId: 'uuid', orgId: 'uuid' })

    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_session_policy' },
      sessionVars,
      {
        using: ({ col, session, sql: s }) =>
          s.raw(`${col.org_id.text} = ${session.orgId.text}`),
      },
    )

    const output = compilePolicyBlock(policy)

    expect(output).toContain("current_setting('app.orgId', true)::uuid")
    expect(output).toContain('"org_id"')
  })

  it('session.userId compiles to current_setting with text type', () => {
    const sessionVars = defineSessionVars({ tenantId: 'text' })

    const policy = definePolicy<DB>()(
      'orders',
      { name: 'orders_tenant_policy' },
      sessionVars,
      {
        using: ({ session, sql: s }) => s.raw(session.tenantId.text),
      },
    )

    const output = compilePolicyBlock(policy)

    expect(output).toContain("current_setting('app.tenantId', true)::text")
  })
})

// ---------------------------------------------------------------------------
// 4. PERMISSIVE vs RESTRICTIVE
// ---------------------------------------------------------------------------
describe('definePolicy — permissiveness', () => {
  it('PERMISSIVE appears in compiled output', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_permissive', as: 'PERMISSIVE', command: 'ALL' },
      null,
      { using: ({ sql: s }) => s.raw('true') },
    )

    const output = compilePolicyBlock(policy)

    expect(output).toContain('AS PERMISSIVE')
  })

  it('RESTRICTIVE appears in compiled output', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_restrictive', as: 'RESTRICTIVE', command: 'SELECT' },
      null,
      { using: ({ sql: s }) => s.raw('true') },
    )

    const output = compilePolicyBlock(policy)

    expect(output).toContain('AS RESTRICTIVE')
  })

  it('omitting permissiveness does not emit AS clause', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_no_as' },
      null,
      { using: ({ sql: s }) => s.raw('true') },
    )

    const output = compilePolicyBlock(policy)

    expect(output).not.toContain('AS PERMISSIVE')
    expect(output).not.toContain('AS RESTRICTIVE')
  })
})

// ---------------------------------------------------------------------------
// 5. Specific command (SELECT, INSERT, etc.)
// ---------------------------------------------------------------------------
describe('definePolicy — command', () => {
  it('SELECT command appears in compiled output', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_select', command: 'SELECT' },
      null,
      { using: ({ sql: s }) => s.raw('true') },
    )

    expect(compilePolicyBlock(policy)).toContain('FOR SELECT')
  })

  it('INSERT command appears in compiled output', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_insert', command: 'INSERT' },
      null,
      { withCheck: ({ sql: s }) => s.raw('true') },
    )

    expect(compilePolicyBlock(policy)).toContain('FOR INSERT')
  })

  it('UPDATE command appears in compiled output', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_update', command: 'UPDATE' },
      null,
      {
        using: ({ sql: s }) => s.raw('true'),
        withCheck: ({ sql: s }) => s.raw('true'),
      },
    )

    expect(compilePolicyBlock(policy)).toContain('FOR UPDATE')
  })

  it('ALL command appears in compiled output', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_all', command: 'ALL' },
      null,
      { using: ({ sql: s }) => s.raw('true') },
    )

    expect(compilePolicyBlock(policy)).toContain('FOR ALL')
  })

  it('omitting command does not emit FOR clause', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_no_cmd' },
      null,
      { using: ({ sql: s }) => s.raw('true') },
    )

    const output = compilePolicyBlock(policy)
    expect(output).not.toContain('FOR SELECT')
    expect(output).not.toContain('FOR ALL')
  })
})

// ---------------------------------------------------------------------------
// 6. Roles array → TO role1, role2
// ---------------------------------------------------------------------------
describe('definePolicy — roles', () => {
  it('single role appears as TO <role>', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_role_policy', roles: ['app_user'] },
      null,
      { using: ({ sql: s }) => s.raw('true') },
    )

    const output = compilePolicyBlock(policy)
    expect(output).toContain('TO app_user')
  })

  it('multiple roles appear as TO role1, role2', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_roles_policy', roles: ['app_user', 'app_admin'] },
      null,
      { using: ({ sql: s }) => s.raw('true') },
    )

    const output = compilePolicyBlock(policy)
    expect(output).toContain('TO app_user, app_admin')
  })

  it('omitting roles does not emit TO clause', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_no_roles' },
      null,
      { using: ({ sql: s }) => s.raw('true') },
    )

    const output = compilePolicyBlock(policy)
    expect(output).not.toContain(' TO ')
  })
})

// ---------------------------------------------------------------------------
// 7. Both USING and WITH CHECK clauses
// ---------------------------------------------------------------------------
describe('definePolicy — USING and WITH CHECK', () => {
  it('both USING and WITH CHECK appear when both are specified', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_both_clauses', command: 'UPDATE' },
      null,
      {
        using: ({ sql: s }) => s.raw('true'),
        withCheck: ({ sql: s }) => s.raw('false'),
      },
    )

    const output = compilePolicyBlock(policy)

    expect(output).toContain('USING (true)')
    expect(output).toContain('WITH CHECK (false)')
  })

  it('only USING when withCheck is omitted', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_using_only', command: 'SELECT' },
      null,
      { using: ({ sql: s }) => s.raw('true') },
    )

    const output = compilePolicyBlock(policy)

    expect(output).toContain('USING (true)')
    expect(output).not.toContain('WITH CHECK')
  })

  it('only WITH CHECK when using is omitted', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_check_only', command: 'INSERT' },
      null,
      { withCheck: ({ sql: s }) => s.raw('NEW."org_id" IS NOT NULL') },
    )

    const output = compilePolicyBlock(policy)

    expect(output).toContain('WITH CHECK (NEW."org_id" IS NOT NULL)')
    expect(output).not.toContain('USING')
  })
})

// ---------------------------------------------------------------------------
// 8. DROP IF EXISTS pattern (no CREATE OR REPLACE for pre-PG17)
// ---------------------------------------------------------------------------
describe('definePolicy — DROP IF EXISTS + CREATE pattern', () => {
  it('emits DROP POLICY IF EXISTS before CREATE POLICY', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_drop_create' },
      null,
      { using: ({ sql: s }) => s.raw('true') },
    )

    const output = compilePolicyBlock(policy)

    const dropIdx = output.indexOf('DROP POLICY IF EXISTS "items_drop_create"')
    const createIdx = output.indexOf('CREATE POLICY "items_drop_create"')

    expect(dropIdx).toBeGreaterThan(-1)
    expect(createIdx).toBeGreaterThan(-1)
    expect(dropIdx).toBeLessThan(createIdx)
  })

  it('does NOT use CREATE OR REPLACE POLICY', () => {
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_no_replace' },
      null,
      { using: ({ sql: s }) => s.raw('true') },
    )

    const output = compilePolicyBlock(policy)
    expect(output).not.toContain('CREATE OR REPLACE POLICY')
  })
})

// ---------------------------------------------------------------------------
// 9. compileAll ordering: RLS enables → policies → procedures → triggers
// ---------------------------------------------------------------------------
describe('compileAll — ordering with RLS', () => {
  it('includes RLS enable before policies and procedures in output', () => {
    const rlsDef = enableRls<DB>()('items')

    const sessionVars = defineSessionVars({ orgId: 'uuid' })
    const policy = definePolicy<DB>()(
      'items',
      { name: 'items_all_policy', command: 'ALL' },
      sessionVars,
      { using: ({ col, session, sql: s }) => s.raw(`${col.org_id.text} = ${session.orgId.text}`) },
    )

    function makeProc(name: string) {
      return defineProcedure({ name }, [], {}, ({ db }) => {
        db.return(sql.raw('NEW'))
      })
    }

    const proc = makeProc('trg_items_fn')
    const trigger = defineTrigger(
      { name: 'trg_items', table: 'items', timing: 'BEFORE', events: ['INSERT'], forEach: 'ROW' },
      proc,
    )

    const output = compileAll([rlsDef, policy, proc, trigger])

    expect(output).toContain('-- Generated by @mesalia/kysely-pg-procedures')
    expect(output).toContain('-- DO NOT EDIT MANUALLY')

    const rlsIdx = output.indexOf('ALTER TABLE "items" ENABLE ROW LEVEL SECURITY')
    const policyIdx = output.indexOf('CREATE POLICY "items_all_policy"')
    const procIdx = output.indexOf('CREATE OR REPLACE FUNCTION trg_items_fn')
    const triggerIdx = output.indexOf('CREATE OR REPLACE TRIGGER trg_items')

    expect(rlsIdx).toBeGreaterThan(-1)
    expect(policyIdx).toBeGreaterThan(-1)
    expect(procIdx).toBeGreaterThan(-1)
    expect(triggerIdx).toBeGreaterThan(-1)

    // RLS enable comes before policy
    expect(rlsIdx).toBeLessThan(policyIdx)
    // Policy comes before procedure
    expect(policyIdx).toBeLessThan(procIdx)
    // Procedure comes before trigger
    expect(procIdx).toBeLessThan(triggerIdx)
  })

  it('compileAll with only RLS definitions still emits header', () => {
    const rlsDef = enableRls<DB>()('orders', { force: true })
    const output = compileAll([rlsDef])

    expect(output).toContain('-- Generated by @mesalia/kysely-pg-procedures')
    expect(output).toContain('ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY')
    expect(output).toContain('ALTER TABLE "orders" FORCE ROW LEVEL SECURITY')
  })
})
