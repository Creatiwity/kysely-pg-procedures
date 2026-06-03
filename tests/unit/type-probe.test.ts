/**
 * Type-only probe — verifies specific type scenarios from task requirements.
 * No runtime assertions; all checks are compile-time only.
 */

import { describe, it } from 'vitest'
import { sql as ksql } from 'kysely'
import type { RawBuilder, SqlBool } from 'kysely'
import { defineRowProcedure, defineTempTable, defineSessionVars, definePolicy } from '../../src/index.js'

type DB = {
  some_table: { id: string; col: string; orgId: string }
}

const modifiedTable = defineTempTable('Modified', {
  itemId: { type: 'uuid', nullable: false },
}, { as: 'modified' })

const session = defineSessionVars({ orgId: 'uuid' })

describe('type scenarios (compile-time only)', () => {
  it('(a) select([ksql`col`.as(alias)]) compiles without any[]', () => {
    defineRowProcedure<DB>()(
      'some_table',
      { name: 'test_proc_a' },
      [modifiedTable],
      {},
      ({ db }) => {
        db.selectFrom('some_table').select([ksql`col`.as('alias')])
      },
    )
  })

  it('(b) db.modified.filter() returns RawBuilder<SqlBool>', () => {
    defineRowProcedure<DB>()(
      'some_table',
      { name: 'test_proc_b' },
      [modifiedTable],
      {},
      ({ db }) => {
        const _filterResult: RawBuilder<SqlBool> = db.modified.filter('m')
        void _filterResult
      },
    )
  })

  it('(c) db.execute(db.updateTable(...).where(db.modified.filter())) is properly typed', () => {
    defineRowProcedure<DB>()(
      'some_table',
      { name: 'test_proc_c' },
      [modifiedTable],
      {},
      ({ db }) => {
        db.execute(
          db.updateTable('some_table')
            .set({ col: ksql`'x'` })
            .where(db.modified.filter('m')),
        )
      },
    )
  })

  it('(d) session.orgId is RawBuilder<any> usable in eb() comparisons', () => {
    definePolicy<DB>()(
      'some_table',
      { name: 'test_policy_d' },
      session,
      ({ eb, session: s }) => ({
        using: eb('orgId', '=', s.orgId),
      }),
    )
  })

  it('(e) whenNew / whenOld / whenInsert / whenUpdate / whenDelete are available', () => {
    defineRowProcedure<DB>()(
      'some_table',
      { name: 'test_proc_e' },
      [modifiedTable],
      {},
      ({ db, whenNew, whenOld, whenInsert, whenUpdate, whenDelete }) => {
        whenNew(({ NEW }) => { db.modified.insert({ itemId: NEW.id }) })
        whenOld(({ OLD }) => { db.modified.insert({ itemId: OLD.id }) })
        whenInsert(({ NEW }) => { db.modified.insert({ itemId: NEW.id }) })
        whenUpdate(({ NEW, OLD }) => { db.modified.insert({ itemId: NEW.id }); void OLD })
        whenDelete(({ OLD }) => { db.modified.insert({ itemId: OLD.id }) })
      },
    )
  })
})
