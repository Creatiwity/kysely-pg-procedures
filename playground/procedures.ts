/**
 * Playground procedure definitions — pure exports, no side effects.
 * This file is the entry point for proc:status / proc:generate.
 */

import {
  defineRowTrigger,
  defineRowProcedure,
  defineTrigger,
  defineTempTable,
  sql,
  ksql,
} from '../src/index.js'
import type { TriggerDefinition } from '../src/index.js'

type DB = {
  playground_items: {
    id: string
    label: string
    score: number
    audit_flag: boolean
  }
}

// ─── Example 1: BEFORE INSERT ROW trigger (inline) ───────────────────────────

const scoreTrigger = defineRowTrigger<DB>()(
  'playground_items',
  {
    name: 'playground_score_trigger',
    procedureName: 'playground_score_proc',
    timing: 'BEFORE',
    events: ['INSERT'] as const,
  },
  [],
  {},
  ({ db, NEW }) => {
    db.set(NEW.score, sql`char_length(${NEW.label}) * 10`)
    db.return(NEW)
  },
)

// ─── Example 2: AFTER UPDATE STATEMENT trigger with temp table (2-step) ──────

const modifiedTable = defineTempTable(
  'PlaygroundModifiedItems',
  {
    itemId: { type: 'uuid', nullable: false },
    oldScore: { type: 'integer', nullable: true },
    newScore: { type: 'integer', nullable: true },
  },
  { as: 'modified' },
)

const auditProc = defineRowProcedure<DB>()(
  'playground_items',
  { name: 'playground_audit_proc' },
  [modifiedTable],
  {},
  ({ db }) => {
    db.modified.insertFrom(
      ['itemId', 'oldScore', 'newScore'],
      db
        .selectFrom('inserted as ins')
        .innerJoin('removed as rem', join => join.onRef('ins.id', '=', 'rem.id'))
        .where(ksql`ins."score" IS DISTINCT FROM rem."score"`)
        .select([
          ksql`ins."id"`.as('itemId'),
          ksql`rem."score"`.as('oldScore'),
          ksql`ins."score"`.as('newScore'),
        ]),
    )

    db.if(db.modified.notExists(), () => {
      db.modified.delete()
      db.return(sql`NULL`)
    })

    db.snapshot('after_collect')

    db.execute(
      db
        .updateTable('playground_items')
        .set({ audit_flag: ksql`TRUE` })
        .from('PlaygroundModifiedItems as m')
        .whereRef('playground_items.id', '=', 'm.itemId')
        .where(db.modified.filter('m')),
      { label: 'flag_modified_items' },
    )

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

// ─── Default export for proc:generate / proc:status ──────────────────────────

export default [scoreTrigger, auditTrigger] satisfies TriggerDefinition[]
