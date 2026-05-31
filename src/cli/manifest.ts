import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseKppBlocks } from './kpp.js'
import type { Manifest, ManifestEntry } from './types.js'

export async function loadManifest(path: string): Promise<Manifest | null> {
  try {
    const content = readFileSync(path, 'utf-8')
    return JSON.parse(content) as Manifest
  } catch {
    return null
  }
}

export async function saveManifest(path: string, manifest: Manifest): Promise<void> {
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf-8')
}

function parsePrefixToIso(filename: string): string {
  const prefix = filename.slice(0, 15)
  const year = prefix.slice(0, 4)
  const month = prefix.slice(4, 6)
  const day = prefix.slice(6, 8)
  const h = prefix.slice(9, 11)
  const m = prefix.slice(11, 13)
  const s = prefix.slice(13, 15)
  return year + '-' + month + '-' + day + 'T' + h + ':' + m + ':' + s + '.000Z'
}

export async function rebuildManifest(migrationsDir: string, rebuiltAt: string): Promise<Manifest> {
  const absDir = resolve(process.cwd(), migrationsDir)

  let files: string[]
  try {
    files = readdirSync(absDir)
      .filter((f) => f.endsWith('.ts'))
      .sort()
  } catch {
    files = []
  }

  // Track latest block per name, plus all files it appeared in for conflict detection
  const latestBlock = new Map<string, { hash: string; kind: 'function' | 'trigger' | 'rls-enable' | 'rls-policy'; lastChanged: string; migrationFile: string }>()
  const allFiles = new Map<string, string[]>()

  for (const filename of files) {
    const fullPath = join(absDir, filename)
    let content: string
    try {
      content = readFileSync(fullPath, 'utf-8')
    } catch {
      continue
    }

    const blocks = parseKppBlocks(content, filename)
    const isoDate = parsePrefixToIso(filename)

    for (const block of blocks) {
      latestBlock.set(block.name, {
        hash: block.hash,
        kind: block.kind,
        lastChanged: isoDate,
        migrationFile: filename,
      })
      const existing = allFiles.get(block.name) ?? []
      if (!existing.includes(filename)) {
        existing.push(filename)
      }
      allFiles.set(block.name, existing)
    }
  }

  const entries: Record<string, ManifestEntry> = {}

  for (const [name, info] of latestBlock) {
    const filesForName = allFiles.get(name) ?? []
    const conflict = filesForName.length >= 2
    const entry: ManifestEntry = {
      kind: info.kind,
      hash: info.hash,
      lastChanged: info.lastChanged,
      migrationFile: info.migrationFile,
      conflict,
    }
    if (conflict) {
      entry.conflictingFiles = filesForName
    }
    entries[name] = entry
  }

  return {
    rebuiltAt,
    rebuiltFrom: 'migration-files',
    entries,
  }
}
