import { z } from 'zod'

/** Default data directory — used when CAMSTACK_DATA env var is not set */
export const DEFAULT_DATA_PATH = 'camstack-data'

/** Bootstrap `server` section — see {@link serverSchema}. */
export type BootstrapServerConfig = {
  port: number
  host: string
  dataPath: string
}

/** Bootstrap `bootstrap` section — see {@link bootstrapAddonsSchema}. */
export type BootstrapAddonsConfig = Record<never, never>

/**
 * Bootstrap config — the three env overrides over built-in defaults, ONLY, at
 * startup, by `loadBootstrapConfig`, the one loader (D1018: there is no
 * config.yaml). A key not named here is not read.
 */
export type BootstrapConfig = {
  server: BootstrapServerConfig
  bootstrap: BootstrapAddonsConfig
}

// Sub-schemas extracted so we can derive defaults for Zod 4 compat.
// In Zod 4, `.default({})` no longer recurses into field defaults.
const serverSchema: z.ZodType<BootstrapServerConfig> = z.object({
  port: z.number().default(4443),
  host: z.string().default('0.0.0.0'),
  dataPath: z.string().default(DEFAULT_DATA_PATH),
})

/**
 * Bootstrap-time addon configuration. Nothing is read from it: the first-boot
 * addon set always comes from the package (the server's own addon-* deps on a
 * hub, `camstack.agentBootstrapAddons` on an agent). A retired key is stripped.
 */
const bootstrapAddonsSchema: z.ZodType<BootstrapAddonsConfig> = z.object({})

const bootstrapSchemaDefinition: z.ZodType<BootstrapConfig> = z.object({
  server: serverSchema.default(serverSchema.parse({})),
  /** The required-addon override (read by the launcher). */
  bootstrap: bootstrapAddonsSchema.default(bootstrapAddonsSchema.parse({})),
})

export const bootstrapSchema: z.ZodType<BootstrapConfig> = bootstrapSchemaDefinition

/**
 * Runtime defaults — re-exported from @camstack/types (canonical location).
 * Kept here for backward compatibility with existing kernel consumers.
 */
export { RUNTIME_DEFAULTS } from '@camstack/types'

export type ServerMode = 'hub' | 'agent'
