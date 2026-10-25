import { z } from 'zod'

/** Default data directory — used when CAMSTACK_DATA env var is not set */
export const DEFAULT_DATA_PATH = 'camstack-data'

/** Bootstrap `server` section — see {@link serverSchema}. */
export type BootstrapServerConfig = {
  port: number
  host: string
  dataPath: string
  corsOrigins: string[]
}

/** Bootstrap `hub` section — see {@link hubSchema}. */
export type BootstrapHubConfig = {
  url: string
  token: string
}

/** Bootstrap `agent` section — see {@link agentSchema}. */
export type BootstrapAgentConfig = {
  name: string
  statusPort: number
}

/** Bootstrap `tls` section — see {@link tlsSchema}. */
export type BootstrapTlsConfig = {
  enabled: boolean
}

/** Bootstrap `bootstrap` section — see {@link bootstrapAddonsSchema}. */
export type BootstrapAddonsConfig = {
  settingsStoreAddon: string
  installSource?: 'npm' | 'local' | 'symlink'
  requiredAddons?: string[]
  forceDisable: string[]
}

/** Bootstrap `keychain` section — see {@link keychainSchema}. */
export type BootstrapKeychainConfig = {
  keyFile?: string
  previousKeyFile?: string
}

/** Bootstrap config -- loaded from config.yaml ONLY at startup. */
export type BootstrapConfig = {
  mode: 'hub' | 'agent'
  server: BootstrapServerConfig
  auth: Record<string, never>
  hub: BootstrapHubConfig
  agent: BootstrapAgentConfig
  tls: BootstrapTlsConfig
  bootstrap: BootstrapAddonsConfig
  keychain: BootstrapKeychainConfig
}

// Sub-schemas extracted so we can derive defaults for Zod 4 compat.
// In Zod 4, `.default({})` no longer recurses into field defaults.
/**
 * A list of browser origins from config.yaml (a YAML list) or from the
 * `CAMSTACK_CORS_ORIGINS` env var (one comma-separated string — env carries
 * only strings). Validation of each entry is the CORS policy's job
 * (`server/backend/src/api/cors/cors-policy.ts`), which logs what it rejects;
 * the schema only fixes the SHAPE so a typo cannot stop the hub from booting.
 */
const originListSchema: z.ZodType<string[]> = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : value,
  z.array(z.string()),
)

const serverSchema: z.ZodType<BootstrapServerConfig> = z.object({
  port: z.number().default(4443),
  host: z.string().default('0.0.0.0'),
  dataPath: z.string().default(DEFAULT_DATA_PATH),
  /**
   * EXTRA browser origins allowed to call this hub cross-origin (D707), on
   * top of the built-ins: the hub's own origin, the hosted viewer PWA and the
   * native app's opaque `null` origin. Bootstrap-owned on purpose — widening
   * who may read hub responses in a browser is a security decision, and the
   * policy is live from the first request, before the settings store exists.
   */
  corsOrigins: originListSchema.default([]),
})

/**
 * The bootstrap `auth` section holds NO credential (D797): the session signing
 * key lives in the keychain, and a fresh hub seeds `admin` / `changeme`
 * (`FIRST_BOOT_ADMIN_*`). The retired keys `jwtSecret`, `adminUsername` and
 * `adminPassword` are stripped when a legacy config.yaml still carries them —
 * the boot warns so the operator removes them (the one-off ops script imports
 * a `jwtSecret` into the keychain first).
 */
const authSchema: z.ZodType<Record<string, never>> = z.object({})

/** `auth.*` keys a pre-D797 config.yaml may still carry; ignored, and warned about. */
export const RETIRED_AUTH_CONFIG_KEYS = ['jwtSecret', 'adminUsername', 'adminPassword'] as const

const hubSchema: z.ZodType<BootstrapHubConfig> = z.object({
  url: z.string().default('ws://localhost:4443/agent'),
  token: z.string().default(''),
})

const agentSchema: z.ZodType<BootstrapAgentConfig> = z.object({
  name: z.string().default(''),
  /** Port for the agent status page (minimal HTML) */
  statusPort: z.number().default(4444),
})

const tlsSchema: z.ZodType<BootstrapTlsConfig> = z.object({
  /**
   * Enable HTTPS (default: true). The certificate itself is never configured
   * here: the admin UI (Network → Local access) generates or uploads it
   * (D726), and boot serves whatever `tls/mode` says.
   */
  enabled: z.boolean().default(true),
})

/**
 * Bootstrap-time addon configuration — read PURELY from YAML, before the
 * kernel can talk to the settings-store. This breaks the chicken-and-egg
 * where the settings store itself is implemented by an addon: the kernel
 * needs to know WHICH addon to load first to provide the store, and that
 * decision can't itself live in the store.
 *
 * Backward-compatible: every field is optional + defaults reproduce the
 * current hard-coded behavior. Existing config.yaml files keep working.
 */
const bootstrapAddonsSchema: z.ZodType<BootstrapAddonsConfig> = z.object({
  /**
   * Addon implementing the `settings-store` capability. Loaded FIRST,
   * before any other addon is enabled — every other addon's enable
   * state, settings, and ordering lives in the store it provides.
   *
   * Default: '@camstack/addon-sqlite-storage' (the workspace's
   * default SQLite-backed store). Future alternatives could swap this
   * for postgres/redis without touching kernel code.
   */
  settingsStoreAddon: z.string().default('@camstack/addon-sqlite-storage'),
  /**
   * How the launcher provisions REQUIRED_PACKAGES into `data/addons/`
   * on startup.
   *
   *   - `'npm'`     — pull from the npm registry (production default).
   *   - `'local'`   — copy `packages/<X>/` from the workspace into
   *                   `data/addons/<X>/`. Use for the Electron-
   *                   packaged bundle and the e2e harness.
   *   - `'symlink'` — point `data/addons/<X>` at the workspace source
   *                   dir via a directory symlink. Dev-only: a
   *                   workspace rebuild (`npm run build -w <X>`) is
   *                   immediately reflected at the next addon load,
   *                   no copy step. Falls back to `'local'` on
   *                   platforms that reject symlink creation (Windows
   *                   without developer-mode).
   *
   * The `CAMSTACK_INSTALL_SOURCE` env var, when set, wins over this
   * field. Leave undefined to keep the launcher's default behaviour
   * (npm when no workspace, local when a bundled addons dir is
   * present, …).
   */
  installSource: z.enum(['npm', 'local', 'symlink']).optional(),
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
  /**
   * Disable list applied AFTER the settings-store reports the enabled
   * set. Operator escape hatch — boot without a known-broken addon
   * without having to mutate the store.
   */
  forceDisable: z.array(z.string()).default([]),
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
  /** Server mode: 'hub' (full server) or 'agent' (worker node) */
  mode: z.enum(['hub', 'agent']).default('hub'),
  server: serverSchema.default(serverSchema.parse({})),
  auth: authSchema.default(authSchema.parse({})),
  /** Hub connection config — only used when mode='agent' */
  hub: hubSchema.default(hubSchema.parse({})),
  /** Agent-specific config — only used when mode='agent' */
  agent: agentSchema.default(agentSchema.parse({})),
  /** TLS configuration */
  tls: tlsSchema.default(tlsSchema.parse({})),
  /**
   * Addon bootstrap directives — minimum addon set needed before the
   * kernel can reach the settings-store. See bootstrapAddonsSchema.
   * Spec: docs/superpowers/specs/2026-05-15-yaml-bootstrap-expansion.md
   */
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

export type AppConfig = BootstrapConfig & {
  features: {
    streaming: boolean
    notifications: boolean
    objectDetection: boolean
    remoteAccess: boolean
    agentCluster: boolean
    smartHome: boolean
    recordings: boolean
    backup: boolean
    repl: boolean
  }
  storage: {
    provider: string
    locations: Record<string, string>
  }
  logging: {
    level: string
    retentionDays: number
  }
  eventBus: {
    /** System-EVENT ring size. Separate from the log buffer below. */
    ringBufferSize: number
    /**
     * Per-addon log ring-buffer capacity, in entries. Default 5000.
     *
     * A HARD bound on EACH addon's bucket, not the total — the buffer is
     * partitioned by `addonId` (`PartitionedLogBuffer`), so a chatty addon evicts
     * only its own lines and a quiet one keeps its sparse history. Worst-case
     * memory is therefore `this × number of addons that have logged`, which is
     * why the total below exists.
     *
     * Hub-only: the agent constructs its `LogManager` with a hardcoded 5000.
     */
    perAddonLogBufferSize?: number
    /**
     * Ceiling on retained entries across every addon bucket.
     *
     * UNSET (the normal case) takes `DEFAULT_MAX_TOTAL_LOG_ENTRIES` — the buffer is
     * bounded in aggregate out of the box. It has to be: `perAddonLogBufferSize ×
     * addons` grows with the roster, and hub-main ingests from every local runner
     * AND every agent, so the measured ~60-bucket hub retained ~300k entries
     * (~92MB at ~306 B/entry) with no aggregate bound at all.
     *
     * Set a number to tune it. Set an explicit `null` to opt out entirely — the
     * per-addon rings then become the only bound again.
     *
     * It is met by discarding entries at or below `logBufferPruneLevel` FIRST, so a
     * live addon's `warn`/`error` are never traded for lines about frame timings.
     * Only when that cannot reach the target are whole least-recently-WRITTEN
     * buckets dropped — a bound that pruning alone cannot hold is not a bound, and
     * the bucket nobody has written to is the cheapest thing in the buffer to lose.
     */
    maxTotalLogBufferSize?: number | null
    /**
     * Highest severity the total-cap sweep may discard. Default `debug`.
     *
     * `debug` reclaims nearly all the space on any busy buffer while leaving
     * `info`/`warn`/`error` untouched. Raise it to `info` only if debug alone is
     * not enough; `warn` and `error` are then still safe. Setting it to `error`
     * means "evict anything", which defeats the point.
     */
    logBufferPruneLevel?: 'debug' | 'info' | 'warn' | 'error'
    /**
     * Entries the hub keeps in memory once `winston-logging` holds the history
     * (D898). Default 2000; the files serve everything older.
     */
    logTailSize?: number
  }
  retention: {
    detectionEventsDays: number
    audioLevelsDays: number
  }
  providers: Array<{
    id: string
    type: string
    name: string
    url?: string
    username?: string
    password?: string
    mqtt?: {
      brokerUrl: string
      username?: string
      password?: string
      topicPrefix: string
    }
  }>
}
