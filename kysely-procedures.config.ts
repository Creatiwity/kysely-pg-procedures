import type { ProcConfig } from './src/cli/types.js'

const config: Partial<ProcConfig> = {
  procedures: ['playground/**/*.ts'],
  manifest: 'kysely-procedures.json',
  migrations: 'playground/migrations/',
}

export default config
