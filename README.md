# kysely-pg-procedures

Type-safe PostgreSQL stored procedures and triggers as versioned TypeScript

---

## What it solves

Writing PostgreSQL stored procedures and triggers in raw SQL is error-prone: no type checking, no refactoring support, and migrations are difficult to version or audit. `kysely-pg-procedures` lets you define procedures and triggers in TypeScript, with full type inference from your Kysely DB schema. A CLI then generates versioned migration files with tamper-detection markers, so you can track every change, detect conflicts from concurrent branches, and safely regenerate the manifest after a merge.

---

## Install

```bash
npm install kysely-pg-procedures
```

---

## Quick start

```typescript
import { defineRowTrigger, sql } from 'kysely-pg-procedures'

// Your Kysely DB schema
interface DB {
  users: {
    id: number
    email: string
    updated_at: Date | null
  }
}

// One-step: define the trigger and its backing function together
const setUpdatedAt = defineRowTrigger<DB>()('users', {
  name: 'users_set_updated_at',
  timing: 'BEFORE',
  events: ['UPDATE'],
  forEach: 'ROW',
}, [], {}, ({ db }) => {
  db.set('updated_at', sql`NOW()`)
  db.return('NEW')
})

export default [setUpdatedAt]
```

Run `npm run proc:generate` to produce a Kysely-compatible migration file.

---

## Core concepts

### TypedRowRef\<T\>

`TypedRowRef<T>` gives you column access that is fully typed from your schema — no `any`. Use `makeTypedRowRef<DB, Table>('NEW')` or `makeTypedRowRef<DB, Table>('OLD')` to obtain a reference to the trigger row.

```typescript
import { makeTypedRowRef } from 'kysely-pg-procedures'
const NEW = makeTypedRowRef<DB, 'users'>('NEW')
NEW.email // typed as string
```

### defineRowTrigger\<DB\>()

The one-step API: creates both the backing PL/pgSQL function and the `CREATE TRIGGER` statement together.

```typescript
defineRowTrigger<DB>()(table, opts, tempTables, vars, body)
```

- `table` — the table name (keyof DB)
- `opts` — trigger options: `name`, `timing`, `events`, `forEach`, optional `when`/`columns`
- `tempTables` — array of `TempTableDef` (from `defineTempTable`)
- `vars` — variable declarations
- `body` — callback receiving `{ sql, db }` for building the function body

### defineRowProcedure\<DB\>() + defineTrigger

The two-step API lets you define the function once and attach multiple triggers or reuse the function elsewhere.

```typescript
const proc = defineRowProcedure<DB>()('users', opts, tempTables, vars, body)
const trigger = defineTrigger({ name: 'users_set_updated_at', table: 'users', ...trigOpts }, proc)
export default [trigger]
```

### STATEMENT triggers and temp tables with alias

For `FOR EACH STATEMENT` triggers you can define temp tables (materialized inside the function) and give them an alias for ergonomic column access:

```typescript
import { defineTempTable } from 'kysely-pg-procedures'

const changedRows = defineTempTable('changed_rows', {
  columns: { id: 'INTEGER', email: 'TEXT' },
  alias: 'cr',
})
```

### sql vs ksql

- `sql` (our tag) — for PL/pgSQL statement fragments: `db.set(col, sql\`expr\`)`, `db.execute(sql\`...\`)`
- `ksql` (Kysely's own `sql`) — for Kysely query builders used inside `.where()`, `.select()`, etc.

Both are exported from `kysely-pg-procedures`.

### db.invoke(proc)

Call another procedure (helper function) from within a procedure body:

```typescript
db.invoke(helperProc)
```

---

## Observability

### Log levels

Set `logLevel` in procedure options:

| Level | What is logged |
|-------|---------------|
| `none` | Nothing |
| `info` | Procedure start/end |
| `step` | Each statement |
| `debug` | Statement + bind values |

### logTarget

- `'table'` — insert log rows into a dedicated table (`proc_log`)
- `'notify'` — send via `NOTIFY` for live streaming

### db.snapshot()

Capture the current state of your temp tables for debugging:

```typescript
db.snapshot('after_insert')
```

---

## Dev workflow

```bash
# Start the database
npm run db:up

# Watch procedure files and hot-reload into the playground DB
npm run db:procedures:watch

# Run the playground script
npm run playground
```

---

## Migration workflow

### 1. Create kysely-procedures.config.ts

```typescript
import type { ProcConfig } from 'kysely-pg-procedures/cli'

const config: Partial<ProcConfig> = {
  procedures: ['src/procedures/**/*.ts'],
  manifest: 'kysely-procedures.json',
  migrations: 'migrations/',
}

export default config
```

The config file is auto-discovered as `kpp.config.ts` in the project root, or you can pass `--config <path>` to any CLI command.

### 2. Procedure files

Each procedure file should export a default array of trigger or procedure definitions:

```typescript
// src/procedures/users.ts
import { defineRowTrigger } from 'kysely-pg-procedures'

export default [myTrigger, anotherTrigger]
```

### 3. proc:generate

```bash
npm run proc:generate
# or with options:
tsx src/cli/index.ts generate --only users_set_updated_at,audit_trigger
```

Generates a Kysely-compatible migration file in your `migrations/` directory, for example:

```
migrations/20240601T120000-procedures.ts
```

The file contains `up()` and `down()` functions compatible with Kysely's migration runner, and every procedure block is wrapped in KPP markers.

You can narrow the output with `--only <a,b,c>` (comma-separated procedure names) or `--file <path>` to specify the output path.

### 4. proc:status

```bash
npm run proc:status
```

Prints a table showing the consistency of every procedure:

| Status | Meaning |
|--------|---------|
| `unchanged` | Source hash matches manifest; migration file not tampered |
| `modified` | Source has changed since last migration |
| `not-migrated` | No migration exists for this procedure yet |
| `orphan` | Exists in migration files but not in source |
| `tampered` | Migration file SQL was edited after generation |
| `conflict` | Same procedure migrated in multiple files (branch merge) |

The command exits with code 1 if any procedure is not `unchanged`.

### 5. proc:manifest-rebuild

```bash
npm run proc:manifest-rebuild
```

Rebuilds `kysely-procedures.json` entirely from the migration files on disk. Run this after resolving a merge conflict in the migrations directory. It is safe to run at any time — the manifest is always derived from migration files, never the source of truth itself.

### 6. KPP markers

Every procedure block in a migration file is wrapped in comment markers:

```sql
-- [KPP:BEGIN name="users_set_updated_at" kind="function" hash="sha256:abc123..."]
CREATE OR REPLACE FUNCTION users_set_updated_at() ...
-- [KPP:END name="users_set_updated_at"]
```

Down blocks use:

```sql
-- [KPP:DOWN:BEGIN name="users_set_updated_at"]
DROP FUNCTION IF EXISTS users_set_updated_at();
-- [KPP:DOWN:END name="users_set_updated_at"]
```

The `hash` attribute in `KPP:BEGIN` is computed from the SQL (whitespace-normalised SHA-256). `proc:status` recomputes the hash from the SQL inside the marker and compares it against the stored hash — if they differ, the block is marked `tampered`.

### 7. Concurrent branches: detection and resolution

If two branches each generate a migration for the same procedure, `proc:status` will report `conflict` after the merge. To resolve:

1. Delete the duplicate migration file (keeping the one with the intended SQL).
2. Run `npm run proc:manifest-rebuild` to regenerate the manifest.
3. Run `npm run proc:status` to confirm there are no remaining conflicts.

Use `--verbose` with `proc:status` to see which files are in conflict.

---

## API reference

| Export | Description |
|--------|-------------|
| `defineRowTrigger<DB>()` | One-step: define a ROW-level trigger + backing function |
| `defineRowProcedure<DB>()` | Define a row trigger function independently |
| `defineTrigger(opts, proc)` | Attach a trigger to an existing procedure definition |
| `defineTempTable(name, def)` | Define a temp table for use inside a procedure |
| `sql` | Tag for PL/pgSQL statement fragments |
| `ksql` | Kysely's `sql` tag for query builders |
| `makeTypedRowRef<DB, T>(rowName)` | Create a typed reference to NEW/OLD trigger row |
| `compileProcedure(def)` | Compile a procedure definition to SQL string |
| `compileTrigger(def)` | Compile a trigger definition to SQL string |
| `compileAll(defs)` | Compile an array of definitions to SQL strings |
| `createProcLogListener(conn)` | Subscribe to `NOTIFY`-based procedure log events |
| `TypedRowRef<T>` | Type for a typed row reference |
| `DbContext` | Type for the `db` object passed to procedure callbacks |

---

## License

MIT
