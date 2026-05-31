import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { hashSql } from './hash.js'
import { parseKppBlocks } from './kpp.js'
import { loadCompiledDefs } from './loader.js'
import { rebuildManifest } from './manifest.js'
import type { ProcConfig, StatusEntry } from './types.js'

export async function runStatus(
  config: ProcConfig,
  opts?: { verbose?: boolean },
): Promise<{ ok: boolean; entries: StatusEntry[] }> {
  const manifest = await rebuildManifest(config.migrations, '1970-01-01T00:00:00.000Z')
  const compiledDefs = await loadCompiledDefs(config.procedures, process.cwd())

  const entries: StatusEntry[] = []
  const seenNames = new Set<string>()

  for (const def of compiledDefs) {
    seenNames.add(def.name)
    const manifestEntry = manifest.entries[def.name]

    if (!manifestEntry) {
      entries.push({
        name: def.name,
        kind: def.kind,
        status: 'not-migrated',
        sourceHash: def.hash,
      })
      continue
    }

    if (manifestEntry.conflict) {
      entries.push({
        name: def.name,
        kind: def.kind,
        status: 'conflict',
        sourceHash: def.hash,
        manifestHash: manifestEntry.hash,
        migrationFile: manifestEntry.migrationFile,
        conflictingFiles: manifestEntry.conflictingFiles,
      })
      continue
    }

    if (def.hash !== manifestEntry.hash) {
      entries.push({
        name: def.name,
        kind: def.kind,
        status: 'modified',
        sourceHash: def.hash,
        manifestHash: manifestEntry.hash,
        migrationFile: manifestEntry.migrationFile,
      })
      continue
    }

    // Tamper check: recompute hash from migration file content
    const absDir = resolve(process.cwd(), config.migrations)
    const migrationFilePath = join(absDir, manifestEntry.migrationFile)
    let tampered = false
    try {
      const fileContent = readFileSync(migrationFilePath, 'utf-8')
      const blocks = parseKppBlocks(fileContent, manifestEntry.migrationFile)
      // Find the last block for this name (most recent in file)
      const block = [...blocks].reverse().find((b) => b.name === def.name)
      if (block) {
        const recomputedHash = hashSql(block.content)
        if (recomputedHash !== block.hash) {
          tampered = true
        }
      }
    } catch {
      // If we can't read the file, treat as tampered
      tampered = true
    }

    if (tampered) {
      entries.push({
        name: def.name,
        kind: def.kind,
        status: 'tampered',
        sourceHash: def.hash,
        manifestHash: manifestEntry.hash,
        migrationFile: manifestEntry.migrationFile,
      })
      continue
    }

    entries.push({
      name: def.name,
      kind: def.kind,
      status: 'unchanged',
      sourceHash: def.hash,
      manifestHash: manifestEntry.hash,
      migrationFile: manifestEntry.migrationFile,
    })
  }

  // Orphans: manifest entries not in source
  for (const [name, manifestEntry] of Object.entries(manifest.entries)) {
    if (seenNames.has(name)) continue

    if (manifestEntry.conflict) {
      entries.push({
        name,
        kind: manifestEntry.kind,
        status: 'conflict',
        manifestHash: manifestEntry.hash,
        migrationFile: manifestEntry.migrationFile,
        conflictingFiles: manifestEntry.conflictingFiles,
      })
    } else {
      entries.push({
        name,
        kind: manifestEntry.kind,
        status: 'orphan',
        manifestHash: manifestEntry.hash,
        migrationFile: manifestEntry.migrationFile,
      })
    }
  }

  // Sort entries by name for stable output
  entries.sort((a, b) => a.name.localeCompare(b.name))

  // Print table
  const statusIcon: Record<StatusEntry['status'], string> = {
    unchanged: '✅',
    modified: '⚠️',
    'not-migrated': '🆕',
    orphan: '❌',
    tampered: '🔒',
    conflict: '💥',
  }

  const colWidths = {
    icon: 3,
    name: Math.max(4, ...entries.map((e) => e.name.length)),
    kind: 8,
    status: Math.max(6, ...entries.map((e) => e.status.length)),
    file: Math.max(4, ...entries.map((e) => e.migrationFile?.length ?? 0)),
  }

  const header = [
    ''.padEnd(colWidths.icon),
    'Name'.padEnd(colWidths.name),
    'Kind'.padEnd(colWidths.kind),
    'Status'.padEnd(colWidths.status),
    'Migration File',
  ].join('  ')

  const separator = '-'.repeat(header.length)

  console.log(separator)
  console.log(header)
  console.log(separator)

  for (const entry of entries) {
    const icon = statusIcon[entry.status]
    const fileCol = entry.migrationFile ?? ''
    const extra =
      opts?.verbose && entry.conflictingFiles
        ? `  conflicts: [${entry.conflictingFiles.join(', ')}]`
        : ''
    console.log(
      [
        icon.padEnd(colWidths.icon),
        entry.name.padEnd(colWidths.name),
        entry.kind.padEnd(colWidths.kind),
        entry.status.padEnd(colWidths.status),
        fileCol,
      ].join('  ') + extra,
    )
  }

  console.log(separator)

  // Summary counts
  const counts: Record<StatusEntry['status'], number> = {
    unchanged: 0,
    modified: 0,
    'not-migrated': 0,
    orphan: 0,
    tampered: 0,
    conflict: 0,
  }
  for (const e of entries) counts[e.status]++

  const parts: string[] = []
  if (counts.unchanged) parts.push(`${counts.unchanged} unchanged`)
  if (counts.modified) parts.push(`${counts.modified} modified`)
  if (counts['not-migrated']) parts.push(`${counts['not-migrated']} not-migrated`)
  if (counts.orphan) parts.push(`${counts.orphan} orphan`)
  if (counts.tampered) parts.push(`${counts.tampered} tampered`)
  if (counts.conflict) parts.push(`${counts.conflict} conflict`)

  const procCount = compiledDefs.filter((d) => d.kind === 'function' || d.kind === 'trigger').length
  const rlsCount = compiledDefs.filter((d) => d.kind === 'rls-enable' || d.kind === 'rls-policy').length
  console.log(`Source files: ${procCount} procedures, ${rlsCount} RLS policies found`)
  console.log(parts.length ? parts.join('  |  ') : 'No entries found.')

  const ok = entries.every((e) => e.status === 'unchanged')
  return { ok, entries }
}
