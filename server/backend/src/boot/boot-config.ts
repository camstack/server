/**
 * Phase 1: Bootstrap config loading and infrastructure setup.
 *
 * Extracted from main.ts — pure extraction, no behavior change.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { EnsureTlsResult } from '@camstack/system'
import { asJsonObject, shortHostname } from '@camstack/types'
import * as yaml from 'js-yaml'
import type { BootstrapConfig } from '../core/config/config.schema'
import { bootstrapSchema } from '../core/config/config.schema'
import { StorageLocationManager } from '../core/storage/storage-location-manager'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { BootstrapConfig }

export interface InfraContext {
  readonly bootstrapConfig: BootstrapConfig
  readonly dataPath: string
  readonly locationManager: StorageLocationManager
  readonly tlsOptions: { key: Buffer; cert: Buffer } | undefined
  /**
   * Present only when the hub generated its own certificate (D227).
   * `undefined` for an uploaded cert and when TLS is off.
   * Carried to post-boot so a reissue reaches the operator as an alert,
   * not just as a boot line nobody reads.
   */
  readonly tlsCert: EnsureTlsResult | undefined
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_DEFAULTS: Record<string, unknown> = {
  server: { port: 4443, host: '0.0.0.0', dataPath: 'camstack-data' },
}

/**
 * Bootstrap env overrides. No SECRET is among them (D783, D797): the session
 * signing key lives in the keychain, the first-boot admin is fixed
 * (`admin` / `changeme`), and there is no cluster secret at all (D857 — a
 * node's identity is its mesh certificate).
 */
const ENV_VAR_MAP: Record<string, string> = {
  CAMSTACK_PORT: 'server.port',
  CAMSTACK_HOST: 'server.host',
  CAMSTACK_DATA: 'server.dataPath',
  CAMSTACK_TLS_ENABLED: 'tls.enabled',
}

/**
 * Env variables that once carried a secret into the hub. Ignored since D797
 * (`CAMSTACK_CLUSTER_SECRET`: the secret itself was removed by D857) —
 * still named so a container template that sets them is told, not silently
 * obeyed or silently dropped. Only their PRESENCE is read, never the value.
 */
const RETIRED_SECRET_ENV = [
  'CAMSTACK_JWT_SECRET',
  'CAMSTACK_ADMIN_USER',
  'CAMSTACK_ADMIN_PASS',
  'CAMSTACK_CLUSTER_SECRET',
  'CAMSTACK_SECRET_KEY',
  'HF_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
] as const

/** `config.yaml` `auth.*` keys that once held a credential — ignored too (D797). */
const RETIRED_AUTH_KEYS = ['jwtSecret', 'adminUsername', 'adminPassword'] as const

/**
 * Env variables that once set the node's certificate. Ignored since D726:
 * the admin UI (Network → Local access) is the one way to set it. Still
 * named here so a node that has them set is told, not silently re-keyed.
 */
const IGNORED_TLS_CERT_ENV = ['CAMSTACK_TLS_CERT', 'CAMSTACK_TLS_KEY'] as const

/** The `config.yaml` keys those variables were mapped onto — ignored too. */
const IGNORED_TLS_CERT_KEYS = ['certPath', 'keyPath'] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setNested(
  obj: Record<string, unknown>,
  p: string,
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = p.split('.')
  if (!head) return obj
  if (rest.length === 0) return { ...obj, [head]: value }
  const child = asJsonObject(obj[head]) ?? {}
  return { ...obj, [head]: setNested(child, rest.join('.'), value) }
}

/**
 * Every env variable and `config.yaml` key that would once have set the
 * certificate and is now ignored (D726). Blank env values count as unset,
 * exactly as the override loop treats them.
 */
export function ignoredTlsCertSources(
  env: Readonly<Record<string, string | undefined>>,
  raw: Readonly<Record<string, unknown>>,
): readonly string[] {
  const fromEnv = IGNORED_TLS_CERT_ENV.filter((name) => {
    const value = env[name]
    return value !== undefined && value !== ''
  })
  const tls = asJsonObject(raw['tls']) ?? {}
  const fromYaml = IGNORED_TLS_CERT_KEYS.filter((key) => tls[key] !== undefined).map(
    (key) => `tls.${key}`,
  )
  return [...fromEnv, ...fromYaml]
}

/**
 * Every retired secret source still present: env variables set (non-blank) and
 * `config.yaml` `auth.*` keys. Names only — a value is never read into a log.
 */
export function retiredSecretSources(
  env: Readonly<Record<string, string | undefined>>,
  raw: Readonly<Record<string, unknown>>,
): readonly string[] {
  const fromEnv = RETIRED_SECRET_ENV.filter((name) => {
    const value = env[name]
    return value !== undefined && value !== ''
  })
  const auth = asJsonObject(raw['auth']) ?? {}
  const fromYaml = RETIRED_AUTH_KEYS.filter(
    (key) => auth[key] !== undefined && auth[key] !== null,
  ).map((key) => `auth.${key}`)
  return [...fromEnv, ...fromYaml]
}

// ---------------------------------------------------------------------------
// loadBootstrapConfig
// ---------------------------------------------------------------------------

/**
 * Load bootstrap config from a YAML file, apply env-var overrides, and
 * validate via the bootstrap Zod schema.
 */
export function loadBootstrapConfig(configPath: string): BootstrapConfig {
  // Only bootstrap sections live in config.yaml.
  // All runtime settings are stored in the SQL system_settings table.

  let raw: Record<string, unknown>

  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8')
    raw = asJsonObject(yaml.load(content)) ?? {}
    // Merge in any missing bootstrap sections (server, auth only)
    let updated = false
    for (const [key, defaults] of Object.entries(CONFIG_DEFAULTS)) {
      if (!(key in raw)) {
        raw[key] = defaults
        updated = true
      }
    }
    if (updated) {
      try {
        const tmpPath = `${configPath}.tmp`
        fs.writeFileSync(
          tmpPath,
          yaml.dump(raw, { lineWidth: 120, indent: 2, quotingType: '"' }),
          'utf-8',
        )
        fs.renameSync(tmpPath, configPath)
        console.log(`[Phase1] Updated config.yaml with missing bootstrap defaults`)
      } catch (err) {
        console.warn(`[Phase1] Could not update config.yaml:`, err)
      }
    }
    console.log(`[Phase1] Loaded bootstrap config from: ${configPath}`)
  } else {
    console.log(`[Phase1] Config file not found at: ${configPath} — writing defaults`)
    const defaults = { ...CONFIG_DEFAULTS }
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      const tmpPath = `${configPath}.tmp`
      fs.writeFileSync(
        tmpPath,
        yaml.dump(defaults, { lineWidth: 120, indent: 2, quotingType: '"' }),
        'utf-8',
      )
      fs.renameSync(tmpPath, configPath)
      console.log(`[Phase1] Default config.yaml written to: ${configPath}`)
    } catch (err) {
      console.warn(`[Phase1] Could not write default config.yaml:`, err)
    }
    raw = defaults
  }

  // Apply env var overrides for bootstrap keys
  for (const [envKey, configPath_] of Object.entries(ENV_VAR_MAP)) {
    const envValue = process.env[envKey]
    if (envValue === undefined || envValue === '') continue
    const coerced: unknown =
      configPath_ === 'server.port'
        ? Number(envValue)
        : configPath_ === 'tls.enabled'
          ? envValue === 'true'
          : envValue
    raw = setNested(raw, configPath_, coerced)
    console.log(`[Phase1] Env override: ${envKey} → ${configPath_}`)
  }

  const retired = retiredSecretSources(process.env, raw)
  if (retired.length > 0) {
    console.warn(
      `[Phase1] WARN ${retired.join(', ')} ignored — no secret is read from the environment or ` +
        'config.yaml any more (D797). The session signing key lives in the ' +
        'keychain; a fresh hub seeds admin / changeme. ' +
        'Remove these entries — after importing their values with scripts/ops/keychain-migrate-hub.mjs.',
    )
  }

  const ignored = ignoredTlsCertSources(process.env, raw)
  if (ignored.length > 0) {
    console.warn(
      `[Phase1] WARN ${ignored.join(', ')} ignored — the certificate is set only in the admin UI. ` +
        'Upload the certificate in Network → Local access (D726).',
    )
  }

  return bootstrapSchema.parse(raw)
}

// ---------------------------------------------------------------------------
// setupInfra
// ---------------------------------------------------------------------------

/**
 * Phase 2: Create StorageLocationManager, ensure directories, configure TLS.
 * Returns the full InfraContext needed by subsequent boot phases.
 */
export async function setupInfra(
  _configPath: string,
  bootstrapConfig: BootstrapConfig,
): Promise<InfraContext> {
  // No secret is generated here: the session signing key is the keychain's
  // (local-auth loads or creates it once the keychain is up — D797).
  const config = bootstrapConfig

  const dataPath = path.resolve(config.server.dataPath)
  const port = config.server.port
  const host = config.server.host

  console.log(`[Phase1] Bootstrap: port=${port}, host=${host}, dataPath=${dataPath}`)

  // --- Phase 2: Init StorageLocationManager → ensure all dirs exist ---
  console.log('[Phase2] Initializing storage locations…')
  const locationManager = new StorageLocationManager(dataPath)
  await locationManager.initializeDefaults()

  const locationStatus = locationManager.getStatus()
  for (const { name, available, path: locPath } of locationStatus) {
    console.log(`[Phase2] Location "${name}": ${available ? 'OK' : 'UNAVAILABLE'} → ${locPath}`)
  }

  // --- Phase 2c: TLS certificate setup ---
  let tlsOptions: { key: Buffer; cert: Buffer } | undefined
  let tlsCert: EnsureTlsResult | undefined

  if (config.tls.enabled) {
    // Use require() instead of import() — the ESM build of @camstack/system has
    // broken chunks with require("fs") when leaked .js files exist in core/src/.
    // CJS build works correctly and tsx supports require().
    const core = require('@camstack/system') as typeof import('@camstack/system')
    // The certificate comes only from the admin UI (D726): the generated
    // local CA → leaf (D227), or an operator upload served verbatim.
    const extraSans = [...core.readExtraSans(dataPath)]
    // A local root CREATED at this boot is named after the hub. The stored name (D861)
    // lives in the settings database, which is not open yet, so this is the name the
    // hub shows while unnamed: the hostname. An existing root is never renamed.
    const boot = await core.prepareBootTls(dataPath, {
      hubName: shortHostname(os.hostname()),
      ...(extraSans.length > 0 ? { extraSans } : {}),
    })
    if (boot.uploadedMissing) {
      console.warn(
        `[Phase2c] WARN the uploaded TLS certificate is missing from ${path.join(dataPath, 'tls')} — serving the generated one. Upload it again in Network → Local access.`,
      )
    }
    if (boot.dormantCaReplaced) {
      console.warn(
        `[Phase2c] WARN the local CA kept beside the uploaded certificate had no name constraints and was replaced by a constrained one (D873). The previous CA stays on disk until the listener is up. Clients that trusted it must download and trust the new CA again.`,
      )
    }
    if (boot.ensured !== undefined) {
      tlsCert = boot.ensured
      logTlsCert(boot.ensured)
    } else {
      console.log(
        `[Phase2c] Serving the uploaded TLS certificate from ${path.join(dataPath, 'tls')}`,
      )
    }
    tlsOptions = { key: boot.pair.key, cert: boot.pair.cert }
  }

  return {
    bootstrapConfig: config,
    dataPath,
    locationManager,
    tlsOptions,
    tlsCert,
  }
}

/**
 * A certificate change is never silent. Anyone who installed the previous
 * certificate as trusted by hand has to act, and the only chance to tell
 * them before a browser does is right here — the scoped logger does not
 * exist yet at phase 2c, so these go to the boot console like every other
 * line in this file, and post-boot re-reports it as an alert.
 */
function logTlsCert(result: EnsureTlsResult): void {
  if (!result.generated) {
    console.log(
      `[Phase2c] TLS cert unchanged — ${result.certPath} (leaf ${result.fingerprintSha256}, valid to ${result.validTo})`,
    )
    return
  }
  console.log(
    `[Phase2c] TLS CERTIFICATE REISSUED — reason=${result.reason}, caRotated=${result.caRotated}`,
  )
  console.log(
    `[Phase2c]   leaf ${result.previousFingerprintSha256 ?? '(none)'} → ${result.fingerprintSha256}`,
  )
  console.log(`[Phase2c]   valid to ${result.validTo}, names: ${result.sans.join(', ')}`)
  if (result.reason === 'ca-unconstrained') {
    console.log(
      `[Phase2c]   The previous local CA had no name constraints (D873); it is kept on disk until the listener serves the new leaf, then removed.`,
    )
  }
  if (result.droppedNames.length > 0) {
    console.log(
      `[Phase2c]   WARN not certified (outside the local CA's name constraints): ${result.droppedNames.join(', ')}`,
    )
  }
  console.log(
    result.caRotated
      ? `[Phase2c]   ACTION REQUIRED: the local CA changed. Install ${result.caCertPath} (SHA-256 ${result.caFingerprintSha256}) on every device that trusted the previous certificate.`
      : `[Phase2c]   Local CA unchanged (${result.caFingerprintSha256}) — devices that trust ${result.caCertPath} keep working.`,
  )
}
