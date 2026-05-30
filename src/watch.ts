/**
 * db:procedures:watch — CLI dev watcher
 *
 * Usage:
 *   node --experimental-strip-types src/watch.ts <glob_pattern> <database_url>
 *
 * Example:
 *   node --experimental-strip-types src/watch.ts "src/procedures/**\/*.ts" postgresql://localhost/mydb
 *
 * On startup it applies every file matching the glob immediately, then watches
 * for changes.  Each changed file is re-imported (dynamic import with a cache-
 * busting query string), compiled with compileAll(), SHA-256 hashed, and
 * applied to the database only when the hash differs from the stored value.
 * File events are debounced 300 ms to handle editor save-storms.
 */

import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import chokidar from 'chokidar'
import { Pool } from 'pg'

import { compileAll } from './compiler.js'
import type { ProcedureDefinition, TriggerDefinition } from './procedure.js'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const [, , globPattern, databaseUrl] = process.argv

if (!globPattern || !databaseUrl) {
  process.stderr.write(
    'Usage: db:procedures:watch <glob_pattern> <database_url>\n' +
      'Example: db:procedures:watch "src/procedures/**/*.ts" postgresql://localhost/mydb\n',
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const pool = new Pool({ connectionString: databaseUrl })
const hashes = new Map<string, string>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Dynamically import a file, bypassing the ESM cache by appending a
 * timestamp query parameter.  The file must have a default export that is
 * an array of ProcedureDefinition | TriggerDefinition.
 */
async function loadDefs(
  filePath: string,
): Promise<Array<ProcedureDefinition | TriggerDefinition>> {
  const fileUrl = pathToFileURL(path.resolve(filePath))
  fileUrl.searchParams.set('t', Date.now().toString())
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const mod = await import(fileUrl.href)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const defs = mod.default as Array<ProcedureDefinition | TriggerDefinition>
  if (!Array.isArray(defs)) {
    throw new TypeError(
      `${filePath}: default export must be an array of ProcedureDefinition | TriggerDefinition`,
    )
  }
  return defs
}

async function applyFile(filePath: string): Promise<void> {
  const start = Date.now()
  const shortName = path.relative(process.cwd(), filePath)

  let defs: Array<ProcedureDefinition | TriggerDefinition>
  try {
    defs = await loadDefs(filePath)
  } catch (err) {
    process.stderr.write(`[proc-watch] error loading ${shortName}: ${String(err)}\n`)
    return
  }

  let sql: string
  try {
    sql = compileAll(defs)
  } catch (err) {
    process.stderr.write(`[proc-watch] error compiling ${shortName}: ${String(err)}\n`)
    return
  }

  const hash = sha256(sql)
  if (hashes.get(filePath) === hash) {
    process.stdout.write(`[proc-watch] ${shortName} unchanged\n`)
    return
  }

  try {
    await pool.query(sql)
  } catch (err) {
    process.stderr.write(`[proc-watch] error applying ${shortName}: ${String(err)}\n`)
    return
  }

  hashes.set(filePath, hash)
  const elapsed = Date.now() - start
  process.stdout.write(`[proc-watch] applied ${shortName} (${elapsed}ms)\n`)
}

function scheduleApply(filePath: string): void {
  const existing = timers.get(filePath)
  if (existing !== undefined) {
    clearTimeout(existing)
  }
  const timer = setTimeout(() => {
    timers.delete(filePath)
    void applyFile(filePath)
  }, 300)
  timers.set(filePath, timer)
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

const watcher = chokidar.watch(globPattern, {
  persistent: true,
  ignoreInitial: false, // fire 'add' for existing files on startup
})

watcher.on('add', (filePath) => {
  scheduleApply(filePath)
})

watcher.on('change', (filePath) => {
  scheduleApply(filePath)
})

watcher.on('error', (err) => {
  process.stderr.write(`[proc-watch] watcher error: ${String(err)}\n`)
})

process.stdout.write(`[proc-watch] watching ${globPattern}\n`)

// Graceful shutdown
async function shutdown(): Promise<void> {
  await watcher.close()
  await pool.end()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
