import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { generateKppDownBlock, generateKppUpBlock, parseKppBlocks } from './kpp.js'
import { loadCompiledDefs } from './loader.js'
import { rebuildManifest, saveManifest } from './manifest.js'
import type { CompiledDef, ProcConfig } from './types.js'

export function formatTimestamp(iso: string): string {
  const tIdx = iso.indexOf('T')
  const datePart = iso.slice(0, tIdx).replace(/-/g, '')
  const timePart = iso.slice(tIdx + 1).replace(/:/g, '').slice(0, 6)
  return datePart + 'T' + timePart
}

export async function runGenerate(
  config: ProcConfig,
  opts: { file?: string; only?: string[]; now: string },
): Promise<void> {
  const compiledDefs = await loadCompiledDefs(config.procedures, process.cwd())
  const manifest = await rebuildManifest(config.migrations, opts.now)

  // Find entries needing migration
  let toMigrate = compiledDefs.filter((def) => {
    const entry = manifest.entries[def.name]
    if (!entry) return true // not-migrated
    return def.hash !== entry.hash // modified
  })

  if (opts.only && opts.only.length > 0) {
    const onlySet = new Set(opts.only)
    toMigrate = toMigrate.filter((def) => onlySet.has(def.name))
  }

  if (toMigrate.length === 0) {
    console.log('Nothing to migrate.')
    return
  }

  // Build UP blocks: rls-enable first, rls-policy next, functions, triggers last
  const upRlsEnable = toMigrate.filter((d) => d.kind === 'rls-enable')
  const upRlsPolicy = toMigrate.filter((d) => d.kind === 'rls-policy')
  const upFunctions = toMigrate.filter((d) => d.kind === 'function')
  const upTriggers = toMigrate.filter((d) => d.kind === 'trigger')
  const upOrdered = [...upRlsEnable, ...upRlsPolicy, ...upFunctions, ...upTriggers]

  const upBlocks = upOrdered.map((def) =>
    generateKppUpBlock(def.name, def.kind, def.hash, def.sql),
  )

  // Build DOWN blocks: triggers first, then functions, then drop policies, then disable rls (reverse of up)
  const downTriggers = upTriggers.slice().reverse()
  const downFunctions = upFunctions.slice().reverse()
  const downRlsPolicy = upRlsPolicy.slice().reverse()
  const downRlsEnable = upRlsEnable.slice().reverse()
  const downOrdered = [...downTriggers, ...downFunctions, ...downRlsPolicy, ...downRlsEnable]

  const absDir = resolve(process.cwd(), config.migrations)

  // Load all migration files to find previous SQL for modified entries
  const getPreviousSql = (name: string): string | null => {
    let files: string[]
    try {
      files = readdirSync(absDir)
        .filter((f) => f.endsWith('.ts'))
        .sort()
    } catch {
      return null
    }
    // Walk files in order, track last seen block content for this name
    let lastContent: string | null = null
    for (const filename of files) {
      try {
        const content = readFileSync(join(absDir, filename), 'utf-8')
        const blocks = parseKppBlocks(content, filename)
        for (const block of blocks) {
          if (block.name === name) {
            lastContent = block.content
          }
        }
      } catch {
        continue
      }
    }
    return lastContent
  }

  const downBlocks = downOrdered.map((def) => {
    const manifestEntry = manifest.entries[def.name]
    const isNew = !manifestEntry

    let downSql: string
    if (!isNew && def.kind !== 'rls-policy' && def.kind !== 'rls-enable') {
      // Modified: find last KPP block content across migration files
      const previousSql = getPreviousSql(def.name)
      if (previousSql !== null) {
        downSql = previousSql
      } else {
        downSql = buildDropSql(def)
      }
    } else {
      // New entries, rls-policy (no REPLACE exists), or rls-enable: always drop
      downSql = buildDropSql(def)
    }

    return generateKppDownBlock(def.name, downSql)
  })

  // Determine output path
  const outputPath =
    opts.file ?? join(absDir, formatTimestamp(opts.now) + '-procedures.ts')

  // Ensure migrations directory exists
  mkdirSync(absDir, { recursive: true })

  // Build changes string
  const changesStr = toMigrate
    .map((def) => {
      const manifestEntry = manifest.entries[def.name]
      const status = !manifestEntry ? 'new' : 'modified'
      return `${def.name}(${status})`
    })
    .join(',')

  // Compose migration file content
  const upSql = upBlocks.join('\n\n')
  const downSql = downBlocks.join('\n\n')

  const fileContent = `import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// [KPP:META generated="${opts.now}" changes="${changesStr}"]

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(\`
${upSql}
  \`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(\`
${downSql}
  \`).execute(db)
}
`

  writeFileSync(outputPath, fileContent, 'utf-8')

  // Rebuild manifest including the new file and save it
  const updatedManifest = await rebuildManifest(config.migrations, opts.now)
  const manifestPath = resolve(process.cwd(), config.manifest)
  await saveManifest(manifestPath, updatedManifest)

  console.log(`Generated: ${outputPath}`)
  console.log(`Changes: ${changesStr}`)
}

function buildDropSql(def: CompiledDef): string {
  if (def.kind === 'trigger') {
    // Extract table name from trigger SQL: ON "tablename"
    const match = /\bON\s+"([^"]+)"/i.exec(def.sql)
    const table = match ? match[1] : 'unknown_table'
    return `DROP TRIGGER IF EXISTS "${def.name}" ON "${table}";`
  }
  if (def.kind === 'rls-enable') {
    // def.name is "rls:<table>"
    const table = def.name.slice('rls:'.length)
    return `ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY;`
  }
  if (def.kind === 'rls-policy') {
    // Extract table name from compiled SQL: ON "tablename"
    const match = /\bON\s+"([^"]+)"/i.exec(def.sql)
    const table = match ? match[1] : 'unknown_table'
    // def.name is "policy:<policyname>"
    const policyName = def.name.slice('policy:'.length)
    return `DROP POLICY IF EXISTS "${policyName}" ON "${table}";`
  }
  const argTypes = extractArgTypes(def.sql)
  return `DROP FUNCTION IF EXISTS ${def.name}(${argTypes});`
}

function extractArgTypes(sql: string): string {
  // Match the opening paren of the function signature
  const match = /CREATE OR REPLACE FUNCTION\s+\S+\s*\(([^)]*)\)/i.exec(sql)
  if (!match || !match[1]?.trim()) return ''
  // Each arg is: [MODE] name type [DEFAULT expr]
  // We only want the type (third token if mode present, second otherwise)
  const args = match[1].split(',').map((arg) => arg.trim()).filter(Boolean)
  const types = args.map((arg) => {
    const tokens = arg.split(/\s+/)
    const modes = ['IN', 'OUT', 'INOUT', 'VARIADIC']
    const startIdx = modes.includes(tokens[0]?.toUpperCase() ?? '') ? 1 : 0
    // name is at startIdx, type is at startIdx+1
    return tokens.slice(startIdx + 1).join(' ').split(/\s+DEFAULT\s+/i)[0] ?? ''
  }).filter(Boolean)
  return types.join(', ')
}
