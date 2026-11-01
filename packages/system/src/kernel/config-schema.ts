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
export type BootstrapAddonsConfig = {
  requiredAddons?: string[]
}

/** Bootstrap `keychain` section — see {@link keychainSchema}. */
export type BootstrapKeychainConfig = {
  keyFile?: string
  previousKeyFile?: string
}

/**
 * Bootstrap config — loaded from config.yaml (plus the three env overrides) ONLY
 * at startup, by `loadBootstrapConfig`, the one loader. A key not named here is
 * not read: an older yaml that still carries `mode`, `hub`, `agent`, `auth`,
 * `tls` or `bootstrap.settingsStoreAddon` / `forceDisable` / `installSource` boots with them ignored.
 */
export type BootstrapConfig = {
  server: BootstrapServerConfig
  bootstrap: BootstrapAddonsConfig
  keychain: BootstrapKeychainConfig
}

// Sub-schemas extracted so we can derive defaults for Zod 4 compat.
// In Zod 4, `.default({})` no longer recurses into field defaults.
const serverSchema: z.ZodType<BootstrapServerConfig> = z.object({
  port: z.number().default(4443),
  host: z.string().default('0.0.0.0'),
  dataPath: z.string().default(DEFAULT_DATA_PATH),
})

/**
 * Bootstrap-time addon configuration — read PURELY from YAML, before the
 * kernel can talk to the settings-store. Every field is optional.
 */
const bootstrapAddonsSchema: z.ZodType<BootstrapAddonsConfig> = z.object({
  /**
   * Override the kernel's hard-coded `AddonInstaller.REQUIRED_PACKAGES`.
   * Passing an array here REPLACES the default list entirely — useful
   * for stripped-down deployments (only the bundle of addons the
   * operator actually wants) and for forcing a different storage
   * backend at first boot.
   *
   * Leave undefined to use the kernel-shipped defaults.
   */
  requiredAddons: z.array(z.string()).optional(),
})

/**
 * Where the keychain's master key lives (D788). config.yaml ONLY: no env var
 * maps here, and the settings store may not answer it
 * (`BOOTSTRAP_OWNED_SECTIONS`). Absent → the desktop OS keychain when the hub
 * runs inside the desktop app, else `<dataDir>/.keychain/master.key`.
 */
const keychainSchema: z.ZodType<BootstrapKeychainConfig> = z.object({
  /** A file holding 32 random bytes, base64 (or hex). Keep it OFF the data volume. */
  keyFile: z.string().min(1).optional(),
  /**
   * The key being rotated away from — consulted only to UNLOCK, so a move to a
   * new key file is: new file, old one here, restart, rotate, remove this.
   */
  previousKeyFile: z.string().min(1).optional(),
})

const bootstrapSchemaDefinition: z.ZodType<BootstrapConfig> = z.object({
  server: serverSchema.default(serverSchema.parse({})),
  /** The required-addon override (read by the launcher). */
  bootstrap: bootstrapAddonsSchema.default(bootstrapAddonsSchema.parse({})),
  /** Keychain master-key location (config.yaml only). */
  keychain: keychainSchema.default({}),
})

export const bootstrapSchema: z.ZodType<BootstrapConfig> = bootstrapSchemaDefinition

/**
 * Runtime defaults — re-exported from @camstack/types (canonical location).
 * Kept here for backward compatibility with existing kernel consumers.
 */
export { RUNTIME_DEFAULTS } from '@camstack/types'

export type ServerMode = 'hub' | 'agent'
