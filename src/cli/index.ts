import { loadConfig } from './config.js'
import { runGenerate } from './generate.js'
import { runStatus } from './status.js'
import { rebuildManifest, saveManifest } from './manifest.js'
import { resolve } from 'node:path'

function parseArgs(argv: string[]): {
  command: string | undefined
  configPath: string | undefined
  file: string | undefined
  only: string[] | undefined
  verbose: boolean
  help: boolean
} {
  const args = argv.slice(2)
  const command = args[0] && !args[0].startsWith('--') ? args[0] : undefined
  const flags = args.slice(command ? 1 : 0)

  let configPath: string | undefined
  let file: string | undefined
  let only: string[] | undefined
  let verbose = false
  let help = false

  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]
    if (flag === '--help' || flag === '-h') {
      help = true
    } else if (flag === '--verbose') {
      verbose = true
    } else if (flag === '--config') {
      configPath = flags[++i]
    } else if (flag === '--file') {
      file = flags[++i]
    } else if (flag === '--only') {
      const val = flags[++i]
      only = val ? val.split(',').map((s) => s.trim()) : []
    }
  }

  return { command, configPath, file, only, verbose, help }
}

function printUsage(): void {
  console.log(`
kysely-pg-procedures CLI

Usage:
  tsx src/cli/index.ts <command> [flags]

Commands:
  status            Check consistency of source procedures vs migration files
  generate          Generate a new migration for new/modified procedures
  manifest-rebuild  Rebuild the manifest from migration files (safe after merge)

Flags:
  --config <path>   Path to config file (default: kpp.config.ts)
  --file <path>     Output file path (generate only)
  --only <a,b,c>    Comma-separated list of procedure names to include (generate only)
  --verbose         Show extra detail (e.g., conflicting files)
  --help            Show this help message
`.trim())
}

async function main(): Promise<void> {
  const { command, configPath, file, only, verbose, help } = parseArgs(process.argv)

  if (help || !command) {
    printUsage()
    return
  }

  if (command === 'status') {
    const config = await loadConfig(configPath)
    const { ok } = await runStatus(config, { verbose })
    if (!ok) process.exit(1)
    return
  }

  if (command === 'generate') {
    const now = new Date().toISOString()
    const config = await loadConfig(configPath)
    await runGenerate(config, { file, only, now })
    return
  }

  if (command === 'manifest-rebuild') {
    const now = new Date().toISOString()
    const config = await loadConfig(configPath)
    const manifest = await rebuildManifest(config.migrations, now)
    const manifestPath = resolve(process.cwd(), config.manifest)
    await saveManifest(manifestPath, manifest)
    const count = Object.keys(manifest.entries).length
    console.log(`Manifest rebuilt from migration files. ${count} entries.`)
    return
  }

  console.error(`Unknown command: ${command}`)
  printUsage()
  process.exit(1)
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(message)
  process.exit(1)
})
