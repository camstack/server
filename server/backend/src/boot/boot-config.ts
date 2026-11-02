/**
 * Phase 1: Bootstrap config loading and infrastructure setup.
 *
 * Extracted from main.ts — pure extraction, no behavior change.
 */

import * as os from 'node:os'
import * as path from 'node:path'
import type { EnsureTlsResult } from '@camstack/server/system'
import {
  loadBootstrapConfig as loadKernelBootstrapConfig,
  readTlsEnabled,
} from '@camstack/server/system'
import { shortHostname } from '@camstack/types'
import type { BootstrapConfig } from '../core/config/config.schema'
import { StorageLocationManager } from '../core/storage/storage-location-manager'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { BootstrapConfig }

export interface InfraContext {
  /** The config.yaml this boot read — `ConfigService` loads the same file. */
  readonly configPath: string
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

/**
 * HTTPS on or off is the `tlsEnabled` setting in Network → Local access, read
 * at boot from the `tls/enabled` marker the setting writes. The old variable
 * is ignored, and named at boot.
 */
const RETIRED_TLS_ENABLED_ENV = 'CAMSTACK_TLS_ENABLED'

/**
 * Env variables that once set the node's certificate. Ignored since D726:
 * the admin UI (Network → Local access) is the one way to set it. Still
 * named here so a node that has them set is told, not silently re-keyed.
 */
const IGNORED_TLS_CERT_ENV = ['CAMSTACK_TLS_CERT', 'CAMSTACK_TLS_KEY'] as const

// ---------------------------------------------------------------------------
// Retired env sources
// ---------------------------------------------------------------------------

/** Names of the env variables in `names` that are set to a non-blank value. */
function setEnvNames(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): readonly string[] {
  return names.filter((name) => {
    const value = env[name]
    return value !== undefined && value !== ''
  })
}

/** The retired HTTPS toggle variable, when set (name only). */
export function retiredTlsEnabledSources(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return setEnvNames(env, [RETIRED_TLS_ENABLED_ENV])
}

/** Every env variable that would once have set the certificate and is now ignored (D726). */
export function ignoredTlsCertSources(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return setEnvNames(env, IGNORED_TLS_CERT_ENV)
}

// ---------------------------------------------------------------------------
// loadBootstrapConfig
// ---------------------------------------------------------------------------

/**
 * The kernel's bootstrap loader (config.yaml + `CAMSTACK_PORT` / `HOST` /
 * `DATA`) — the ONE loader — plus a boot warning for the retired HTTPS
 * variables still set, so a container template that carries one is told.
 */
export function loadBootstrapConfig(configPath: string): BootstrapConfig {
  const config = loadKernelBootstrapConfig(configPath, { warnRetiredKeys: true })
  const env = process.env

  const retiredTls = retiredTlsEnabledSources(env)
  if (retiredTls.length > 0) {
    console.warn(
      `[Phase1] WARN ${retiredTls.join(', ')} ignored — HTTPS on or off is the "Serve HTTPS" ` +
        'setting in Network → Local access (applies after a restart). Remove the entry.',
    )
  }

  const ignored = ignoredTlsCertSources(env)
  if (ignored.length > 0) {
    console.warn(
      `[Phase1] WARN ${ignored.join(', ')} ignored — the certificate is set only in the admin UI. ` +
        'Upload the certificate in Network → Local access (D726).',
    )
  }

  return config
}

// ---------------------------------------------------------------------------
// setupInfra
// ---------------------------------------------------------------------------

/**
 * Phase 2: Create StorageLocationManager, ensure directories, configure TLS.
 * Returns the full InfraContext needed by subsequent boot phases.
 */
export async function setupInfra(
  configPath: string,
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

  // HTTPS is on unless the operator turned it off in Network → Local access: that
  // setting writes the `tls/enabled` marker, and a node with none (first boot) serves HTTPS.
  const tlsEnabled = readTlsEnabled(dataPath)
  console.log(`[Phase2c] HTTPS ${tlsEnabled ? 'on' : 'off (Network → Local access)'}`)
  if (tlsEnabled) {
    // Use require() instead of import() — the ESM build of @camstack/server/system has
    // broken chunks with require("fs") when leaked .js files exist in core/src/.
    // CJS build works correctly and tsx supports require().
    const core = require('@camstack/server/system') as typeof import('@camstack/server/system')
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
    configPath,
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
