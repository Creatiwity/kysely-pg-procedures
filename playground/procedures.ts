/**
 * Playground procedure definitions — pure exports, no side effects.
 * This file is the entry point for proc:status / proc:generate.
 */

import type { ProcDBMap } from "./db-proc.generated.js";

import {
  defineTrigger,
  defineTempTable,
  defineSessionVars,
  enableRls,
  definePolicy,
  sql,
  ksql,
  withProcDB,
} from "../src/index.js";
import type {
  TriggerDefinition,
  RlsEnableDef,
  PolicyDef,
} from "../src/index.js";

type DB = {
  playground_items: {
    id: string;
    label: string;
    score: number;
    audit_flag: boolean;
  };
};

// ─── Example 1: BEFORE INSERT ROW trigger (inline) ───────────────────────────

const { defineRowTrigger, defineRowProcedure } = withProcDB<ProcDBMap>();

const scoreTrigger = defineRowTrigger(
  "playground_items",
  {
    name: "playground_score_trigger",
    procedureName: "playground_score_proc",
    timing: "BEFORE",
    events: ["INSERT"] as const,
  },
  [],
  {},
  ({ db, NEW, whenInsert }) => {
    db.set(NEW.score, sql`char_length(${NEW.label}) * 10`);
    db.return(NEW);
  },
);

// ─── Example 2: AFTER UPDATE STATEMENT trigger with temp table (2-step) ──────

const modifiedTable = defineTempTable(
  "playground_modified_items",
  {
    itemId: { type: "uuid", nullable: false },
    oldScore: { type: "integer", nullable: true },
    newScore: { type: "integer", nullable: true },
  },
  { as: "modified" },
);

const auditProc = defineRowProcedure(
  "playground_items",
  { name: "playground_audit_proc", events: ["UPDATE"] as const },
  [modifiedTable],
  {},
  ({ db }) => {
    db.modified.insertFrom(
      ["itemId", "oldScore", "newScore"],
      db
        .selectFrom("inserted as ins")
        .innerJoin("removed as rem", (join) =>
          join.onRef("ins.id", "=", "rem.id"),
        )
        .where(ksql`ins."score" IS DISTINCT FROM rem."score"`)
        .select([
          ksql`ins."id"`.as("itemId"),
          ksql`rem."score"`.as("oldScore"),
          ksql`ins."score"`.as("newScore"),
        ]),
    );

    db.if(db.modified.notExists(), () => {
      db.modified.delete();
      db.return(sql`NULL`);
    });

    db.snapshot("after_collect");

    db.execute(
      db
        .updateTable("playground_items")
        .set({ audit_flag: ksql`TRUE` })
        .from("playground_modified_items as m")
        .whereRef("playground_items.id", "=", "m.itemId")
        .where(db.modified.filter("m")),
      { label: "flag_modified_items" },
    );

    db.return(sql`NULL`);
  },
);

const auditTrigger = defineTrigger(
  {
    name: "playground_audit_trigger",
    table: "playground_items",
    timing: "AFTER",
    events: ["UPDATE"],
    forEach: "STATEMENT",
    referencing: { old: "removed", new: "inserted" },
  },
  auditProc,
);

// ─── RLS example: multi-tenant isolation ─────────────────────────────────────

// Session variables declared once — reused across all policies.
// Set by middleware: SET LOCAL app.orgId = $orgId
const session = defineSessionVars({
  orgId: "uuid", // current_setting('app.orgId', true)::uuid in policies
  userId: "uuid", // current_setting('app.userId', true)::uuid
});

// Enable RLS on the table (FORCE so even the table owner is restricted)
const rlsItems = enableRls<DB>()("playground_items", { force: true });

// Tenant isolation: use Kysely's ExpressionBuilder for type-checked conditions.
// session.orgId is a RawBuilder usable directly in eb() comparisons.
const tenantPolicy = definePolicy<DB>()(
  "playground_items",
  {
    name: "playground_items_tenant_isolation",
    as: "PERMISSIVE",
    command: "ALL",
    roles: ["app_user"],
  },
  session,
  ({ eb, session: s }) => ({
    // USING: visible rows must have a non-null score and a valid orgId session var
    using: eb.and([eb("score", "is not", null), eb("id", "is not", null)]),
    // WITH CHECK: writes require orgId session var to be set
    withCheck: eb("id", "is not", null),
  }),
);

// ─── Default export for proc:generate / proc:status ──────────────────────────

export default [
  rlsItems,
  tenantPolicy,
  scoreTrigger,
  auditTrigger,
] satisfies Array<RlsEnableDef | PolicyDef | TriggerDefinition>;
