# kysely-pg-procedures

Type-safe PostgreSQL stored procedures and triggers as versioned TypeScript.

---

## What it solves

Writing PostgreSQL stored procedures and triggers in raw SQL is error-prone: no type checking, no refactoring support, and migrations are hard to version or audit. `kysely-pg-procedures` lets you define procedures and triggers in TypeScript with full type inference from your DB schema. A CLI generates versioned Kysely-compatible migration files with tamper-detection markers so you can track every change, detect conflicts from concurrent branches, and safely regenerate the manifest after a merge.

---

## Install

```bash
npm install kysely-pg-procedures kysely
```

---

## Quick start

```typescript
// src/procedures/users.ts
import { defineRowTrigger, sql } from 'kysely-pg-procedures'

// Declare your DB schema once — table names become type-checked keys
type DB = {
  users: {
    id: number
    email: string
    updated_at: Date | null
  }
}

// One-step: creates the PL/pgSQL function and the CREATE TRIGGER statement together.
// 'users' is a keyof DB — its row type is inferred automatically.
// NEW and OLD availability is determined by events (INSERT/UPDATE → NEW, UPDATE/DELETE → OLD).
const setUpdatedAt = defineRowTrigger<DB>()(
  'users',
  {
    name: 'users_set_updated_at',
    procedureName: 'fn_users_set_updated_at',
    timing: 'BEFORE',
    events: ['UPDATE'] as const,
  },
  [], // temp tables
  {}, // vars
  ({ db, NEW }) => {
    db.set(NEW.updated_at, sql`NOW()`)
    db.return(NEW)
  },
)

export default [setUpdatedAt]
```

Then generate the migration:

```bash
npm run proc:generate
```

---

## Core concepts

### Typed row references (NEW / OLD)

`NEW` and `OLD` are provided by the callback with columns typed from your DB schema — no `any`. Column access returns `ColumnRef`, which is usable in `db.set`, `db.return`, `db.if`, etc.

```typescript
({ db, NEW }) => {
  // NEW.email is typed as ColumnRef (derived from DB['users']['email'])
  db.set(NEW.updated_at, sql`NOW()`)
  db.return(NEW)  // compiles to RETURN NEW;
}
```

With `events: ['INSERT'] as const`, only `NEW` is available in the callback. With `['UPDATE'] as const`, both `NEW` and `OLD` are available. With `['DELETE'] as const`, only `OLD` is available.

### defineRowTrigger\<DB\>() — one-step

Creates both the PL/pgSQL function and the `CREATE TRIGGER` statement in one call.

```typescript
defineRowTrigger<DB>()(
  table,        // keyof DB — deduces row type, type-checked table name
  opts,         // { name, procedureName, timing, events, when?, columns? }
  tempTables,   // TempTableDef[] from defineTempTable(...)
  vars,         // { varName: ColumnType } — compiled to DECLARE block
  body,         // ({ sql, db, NEW, OLD }) => void — imperative, auto-pushed
)
```

### defineRowProcedure\<DB\>() + defineTrigger — two-step

Use when the same function is reused across multiple triggers, or when you want to separate the function definition from the trigger DDL.

```typescript
const proc = defineRowProcedure<DB>()(
  'users',
  { name: 'fn_users_set_updated_at' },
  [], {}, ({ db, NEW, OLD }) => { ... },
)

const trigger = defineTrigger(
  { name: 'users_set_updated_at', table: 'users', timing: 'BEFORE', events: ['UPDATE'], forEach: 'ROW' },
  proc,
)

export default [trigger]
```

### Row-Level Security (RLS)

Define RLS policies alongside your triggers — same DSL, same migration workflow, same KPP tamper detection.

```typescript
import { defineSessionVars, enableRls, definePolicy } from 'kysely-pg-procedures'

// 1. Declare session variables set by your middleware
const session = defineSessionVars({
  orgId:  'uuid',   // SET LOCAL app.orgId = '<uuid>'
  userId: 'uuid',   // SET LOCAL app.userId = '<uuid>'
})

// 2. Enable RLS on the table
const rlsItems = enableRls<DB>()('items', { force: true })

// 3. Define a policy (table name is type-checked against DB schema)
const tenantPolicy = definePolicy<DB>()(
  'items',
  {
    name:    'items_tenant_isolation',
    as:      'PERMISSIVE',
    command: 'ALL',
    roles:   ['app_user'],
  },
  session,
  {
    // col.xxx → "xxx" (typed to columns of DB['items'])
    // session.orgId → current_setting('app.orgId', true)::uuid
    using:     ({ col, session: s }) => sql.raw(`${col.org_id.text} = ${s.orgId.text}`),
    withCheck: ({ col, session: s }) => sql.raw(`${col.org_id.text} = ${s.orgId.text}`),
  },
)

export default [rlsItems, tenantPolicy, myTrigger]
```

**Compilation output:**
```sql
ALTER TABLE "items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "items" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "items_tenant_isolation" ON "items";
CREATE POLICY "items_tenant_isolation" ON "items" AS PERMISSIVE FOR ALL TO app_user
    USING ("org_id" = current_setting('app.orgId', true)::uuid)
    WITH CHECK ("org_id" = current_setting('app.orgId', true)::uuid);
```

No `CREATE OR REPLACE POLICY` (requires PG 17) — uses `DROP IF EXISTS` + `CREATE` for broad compatibility.

**Session variables** are set by your HTTP middleware before each request:
```typescript
await sql`SET LOCAL "app.orgId" = ${ctx.org.id}`.execute(db)
await sql`SET LOCAL "app.userId" = ${ctx.user.id}`.execute(db)
```

**`proc:generate`** includes RLS entries in the migration file with KPP markers (`kind="rls-enable"` / `kind="rls-policy"`). **`proc:status`** tracks and detects tampering for RLS blocks the same way it does for procedures.

---

### Typed temp tables with proc:codegen

By default, `db.selectFrom('MyTempTable')` inside a procedure body isn't type-checked against the temp table's columns. Run `proc:codegen` to generate a per-procedure DB extension file that makes temp tables visible to Kysely's type system.

**1. Add to `kysely-procedures.config.ts`:**
```typescript
codegen: {
  // Same format as kysely-codegen's import
  dbImport: "import type { Database as DB } from './generated/database.js'",
  output: 'src/db-proc.generated.ts',
}
```

**2. Run the generator:**
```bash
npm run proc:codegen
```

**3. Generated file (`db-proc.generated.ts`):**
```typescript
// AUTO-GENERATED — DO NOT EDIT

import type { Database as DB } from './generated/database.js'

export interface DBProcMyAuditProc extends DB {
  readonly __proc: 'my_audit_proc'   // discriminant for TypeScript narrowing
  MyTempTable: {
    readonly _proc_instance_id: string
    readonly userId: string
    readonly amount: number | null
  }
}

export type DBProc = DBProcMyAuditProc | ...

export type ProcDBMap = {
  'my_audit_proc': DBProcMyAuditProc
  // one entry per procedure
}
```

**4. Use `withProcDB<ProcDBMap>()`** — the procedure name selects the right extended DB type automatically; no type parameter needed at each call site:

```typescript
import { withProcDB } from 'kysely-pg-procedures'
import type { ProcDBMap } from './db-proc.generated'

const { defineRowProcedure, defineRowTrigger } = withProcDB<ProcDBMap>()

// `procedureName` discriminates → body typed with DBProcMyAuditProc
const proc = defineRowProcedure(
  'items',
  { name: 'my_audit_proc', ... },
  [myTempTable], {},
  ({ db }) => {
    db.selectFrom('MyTempTable').select(['userId'])  // ✓ type-checked
    db.modified.insertFrom(...)                       // ✓ alias still works
  },
)
```

Re-run `proc:codegen` whenever you add or modify a temp table definition.

---

### STATEMENT triggers and temp tables

For `FOR EACH STATEMENT` triggers, use `defineProcedure` and define temp tables with `defineTempTable`. Give temp tables an alias for ergonomic access via `db[alias]`.

```typescript
import { defineProcedure, defineTrigger, defineTempTable, sql } from 'kysely-pg-procedures'

const changedRows = defineTempTable(
  'changed_rows',
  { user_id: 'integer', email: 'text' },
  { as: 'cr' },  // accessible as db.cr in the callback
)

const auditProc = defineProcedure(
  { name: 'fn_audit_users' },
  [changedRows],
  {},
  ({ db, sql }) => {
    db.cr.insertFrom(['user_id', 'email'], sql`SELECT id, email FROM inserted`)
    db.if(db.cr.notExists(), () => { db.return(sql`NULL`) })
    db.execute(sql`UPDATE audit_log SET ... FROM changed_rows AS cr WHERE ${db.cr.filter('cr')}`)
    db.return(sql`NULL`)
  },
)

const auditTrigger = defineTrigger(
  {
    name: 'trg_audit_users',
    table: 'users',
    timing: 'AFTER',
    events: ['INSERT', 'UPDATE'],
    forEach: 'STATEMENT',
    referencing: { old: 'removed', new: 'inserted' },
  },
  auditProc,
)
```

### sql vs ksql

Two SQL tags are exported:

- **`sql`** — our tag, for PL/pgSQL statement fragments: `db.set(col, sql\`expr\`)`, `db.execute(sql\`...\`)`, template interpolation of `SqlFragment`
- **`ksql`** — Kysely's own `sql` tag, for expressions inside Kysely query builders (`.where(ksql\`...\`)`, `.select([ksql\`col\`.as('alias')])`, etc.)

```typescript
// Inside a procedure body:
db.cr.insertFrom(
  ['user_id'],
  db.selectFrom('inserted').where(ksql`score > 0`).select([ksql`id`.as('user_id')]),
)

db.execute(sql`UPDATE ... WHERE ${db.cr.filter('cr')}`)
```

`filter()` on a temp table helper returns a Kysely `RawBuilder` — it works both in Kysely's `.where()` and in our `sql` template tag.

### db.invoke(proc, args?)

Call a helper function (RETURNS VOID) from within a procedure body:

```typescript
db.invoke(helperProc)                    // PERFORM helper_fn();
db.invoke(helperProc, [db.var.qty])      // PERFORM helper_fn(qty);
```

---

## Observability

Log levels are baked in at SQL generation time — zero overhead in production.

```typescript
compileAll(defs, { log: 'info', logTarget: 'table' })
```

| `log` | What is emitted |
|-------|----------------|
| `none` (default) | Nothing |
| `info` | One entry per procedure execution |
| `step` | One entry per mutating statement (batched, single INSERT on RETURN) |
| `debug` | Continuous snapshots of temp tables and vars |

`logTarget`:
- `'table'` — INSERT to unlogged `_proc_log` / `_proc_log_steps` tables
- `'notify'` — `pg_notify('proc_log', ...)` for live streaming to a Node listener

Run `logSetupSql()` once to create the log tables. Use `createProcLogListener(pool)` in your Node process to subscribe to `pg_notify` events.

### db.snapshot(label)

Capture the state of all temp tables and declared vars at a point in the procedure. Only emitted when compiled with `{ debug: true }` (or `log: 'debug'`). Zero SQL in production.

```typescript
db.snapshot('after_insert')
```

Run `snapshotSetupSql()` once to create the snapshot tables.

---

## Dev workflow

```bash
# Start local PostgreSQL (port 5433)
npm run db:up

# Apply procedure changes immediately to local DB on save
npm run db:procedures:watch "src/procedures/**/*.ts" postgresql://localhost/mydb

# Run the playground script (compile + optional apply to local PG)
npm run playground -- --dry
npm run playground -- --log step --target notify
```

---

## Migration workflow

### 1. Create kysely-procedures.config.ts

```typescript
import type { ProcConfig } from 'kysely-pg-procedures'

const config: Partial<ProcConfig> = {
  procedures: ['src/procedures/**/*.ts'],  // glob patterns for definition files
  manifest: 'kysely-procedures.json',      // derived index (safe to regenerate)
  migrations: 'migrations/',               // output folder for migration files
}

export default config
```

The config file is auto-discovered as `kysely-procedures.config.ts` in the project root, or pass `--config <path>` to any CLI command.

Add a `codegen` section if you use `proc:codegen` (see [Typed temp tables with proc:codegen](#typed-temp-tables-with-proccodegen)).

### 2. Procedure files

Each file exports a default array of trigger or procedure definitions:

```typescript
// src/procedures/users.ts
import { defineRowTrigger } from 'kysely-pg-procedures'
// ...
export default [setUpdatedAt, auditTrigger]
```

### 3. proc:generate

```bash
npm run proc:generate
# Options:
npm run proc:generate -- --only fn_users_set_updated_at,trg_audit_users
npm run proc:generate -- --file migrations/my-feature.ts
```

Generates a Kysely-compatible migration file, for example `migrations/20260601T120000-procedures.ts`, containing:

- `up()` — `CREATE OR REPLACE FUNCTION` / `CREATE OR REPLACE TRIGGER` statements
- `down()` — drops (for new entries) or restores the previous SQL (for modified entries)

### 4. proc:status

```bash
npm run proc:status
```

Compares source code against migration files and prints a status table:

| Icon | Status | Meaning |
|------|--------|---------|
| ✅ | `unchanged` | Source hash matches manifest; migration file not tampered |
| ⚠️ | `modified` | Source changed since last migration — run `proc:generate` |
| 🆕 | `not-migrated` | No migration exists yet — run `proc:generate` |
| ❌ | `orphan` | In migration files but not in source |
| 🔒 | `tampered` | Migration file SQL was edited after generation (KPP hash mismatch) |
| 💥 | `conflict` | Same procedure migrated in multiple files (branch merge) |

Exits with code 1 if any entry is not `unchanged`.

### 5. proc:manifest-rebuild

```bash
npm run proc:manifest-rebuild
```

Rebuilds `kysely-procedures.json` from KPP markers in migration files. Run this after resolving a merge conflict. The manifest is always derived from migration files — it is never the source of truth.

### 6. KPP markers

Every generated block is wrapped in comment markers that embed the hash:

```sql
-- [KPP:BEGIN name="fn_users_set_updated_at" kind="function" hash="sha256:abc123..."]
CREATE OR REPLACE FUNCTION fn_users_set_updated_at() ...
-- [KPP:END name="fn_users_set_updated_at"]
```

Down blocks:

```sql
-- [KPP:DOWN:BEGIN name="fn_users_set_updated_at"]
DROP FUNCTION IF EXISTS fn_users_set_updated_at();
-- [KPP:DOWN:END name="fn_users_set_updated_at"]
```

`proc:status` recomputes the hash from the SQL inside each marker and compares it against the stored hash. A mismatch means the block was manually edited after generation.

### 7. Concurrent branches: detection and resolution

If two branches each generate a migration for the same procedure, `proc:status` reports `💥 conflict` after the merge. To resolve:

1. Delete the duplicate migration file (keep the one with the intended SQL).
2. Run `npm run proc:manifest-rebuild` to regenerate the manifest.
3. Run `npm run proc:status` to confirm no remaining conflicts.

---

## API reference

### Definition

| Export | Description |
|--------|-------------|
| `defineRowTrigger<DB>()` | One-step: ROW trigger + backing function; table name typed against DB schema |
| `defineRowProcedure<DB>()` | Row procedure only (attach with `defineTrigger`) |
| `withProcDB<ProcDBMap>()` | Pre-bind all factories to a codegen'd `ProcDBMap`; proc name acts as discriminant |
| `defineTrigger(opts, proc)` | Attach a trigger to an existing procedure definition |
| `defineProcedure(opts, tempTables, vars, body)` | Low-level: any procedure type (STATEMENT triggers, RETURNS VOID helpers, etc.) |
| `defineTempTable(name, columns, { as? })` | Define a temp table; accessible as `db[alias]` in the body |

### Compilation

| Export | Description |
|--------|-------------|
| `compileAll(defs, opts?)` | Compile definitions to SQL. `opts`: `{ debug?, log?, logTarget? }` |
| `compileProcedure(def, opts?)` | Compile a single procedure definition |
| `compileTrigger(def)` | Compile a single trigger definition |

### SQL tags

| Export | Use in |
|--------|--------|
| `sql` | PL/pgSQL statement fragments (`db.set`, `db.execute`, template interpolation) |
| `ksql` | Kysely query builders (`.where`, `.select`, `.set`, etc.) |

### Observability setup

| Export | Description |
|--------|-------------|
| `logSetupSql()` | SQL to create `_proc_log` / `_proc_log_steps` tables (run once) |
| `snapshotSetupSql()` | SQL to create `_proc_snapshot*` tables (run once, dev only) |
| `createProcLogListener(pool, opts?)` | Subscribe to `pg_notify` proc log events in Node.js |

### Types

| Export | Description |
|--------|-------------|
| `TypedRowRef<TRow>` | Typed reference to a trigger row (NEW / OLD) |
| `DbContext<TAliases>` | Type of the `db` object in procedure callbacks |
| `TempTableAliasMap<TTables>` | Maps temp table aliases to their typed helpers |
| `ProcConfig` | Config file shape for `kysely-procedures.config.ts` |
| `CompileOpts` | Options for `compileAll` / `compileProcedure` |

---

## License

MIT © Creatiwity
