import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { compileProcedure, compileTrigger } from '../../src/compiler.js'
import { hashSql } from './hash.js'
import type { CompiledDef } from './types.js'

function globToRegex(pattern: string): RegExp {
  // Escape special regex chars except * which we handle below
  let re = ''
  let i = 0
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      re += '.*'
      i += 2
      // consume optional trailing slash
      if (pattern[i] === '/') i++
    } else if (pattern[i] === '*') {
      re += '[^/]*'
      i++
    } else {
      re += pattern[i]!.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      i++
    }
  }
  return new RegExp('^' + re + '$')
}

function walkDir(dir: string): string[] {
  const results: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return results
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      results.push(...walkDir(full))
    } else {
      results.push(full)
    }
  }
  return results
}

function expandGlob(pattern: string, cwd: string): string[] {
  // Determine fixed prefix (portion before any wildcard)
  const parts = pattern.split('/')
  let fixedParts: string[] = []
  for (const part of parts) {
    if (part.includes('*')) break
    fixedParts.push(part)
  }
  const baseDir = resolve(cwd, fixedParts.join('/'))
  const allFiles = walkDir(baseDir)

  const absolutePattern = resolve(cwd, pattern)
  const regex = globToRegex(absolutePattern)

  return allFiles.filter((f) => f.endsWith('.ts') && regex.test(f))
}

export async function loadCompiledDefs(globs: string[], cwd: string): Promise<CompiledDef[]> {
  const matchedFiles = new Set<string>()
  for (const pattern of globs) {
    for (const file of expandGlob(pattern, cwd)) {
      matchedFiles.add(file)
    }
  }

  const byName = new Map<string, CompiledDef>()

  for (const absolutePath of matchedFiles) {
    const mod = await import(absolutePath)
    const defs: unknown[] = mod.default ?? mod.procedures
    if (!Array.isArray(defs)) continue

    for (const def of defs) {
      if (!def || typeof def !== 'object' || !('_tag' in def)) continue
      const d = def as { _tag: string; name?: string; procedure?: { name: string } }

      if (d._tag === 'Trigger') {
        // Emit the backing function
        const fnSql = compileProcedure((def as any).procedure)
        const fnName: string = (def as any).procedure.name
        if (!byName.has(fnName)) {
          byName.set(fnName, {
            name: fnName,
            kind: 'function',
            sql: fnSql,
            hash: hashSql(fnSql),
          })
        }
        // Emit the trigger itself
        const trigSql = compileTrigger(def as any)
        const trigName: string = (def as any).name
        if (!byName.has(trigName)) {
          byName.set(trigName, {
            name: trigName,
            kind: 'trigger',
            sql: trigSql,
            hash: hashSql(trigSql),
          })
        }
      } else if (d._tag === 'Procedure') {
        const fnSql = compileProcedure(def as any)
        const fnName: string = (def as any).name
        if (!byName.has(fnName)) {
          byName.set(fnName, {
            name: fnName,
            kind: 'function',
            sql: fnSql,
            hash: hashSql(fnSql),
          })
        }
      }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
