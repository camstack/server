/**
 * Environment + defaults: loading —
 * `ConfigManager`'s bootstrap layer, split out of `config-manager.ts` (D675)
 * so that file stays one class. The `console.*` calls are the documented
 * residuals described on `ConfigManager` (no logger exists yet at boot).
 */
import { type BootstrapConfig, bootstrapSchema } from './config-schema.js'
import { logLegacyNotes, reconcileLegacyConfigYaml } from './legacy-config-yaml.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Maps environment variable names to dot-notation config paths.
 * Only bootstrap-level env vars -- runtime settings come from the
 * `settings-store` capability provider.
 */
//
// No secret travels through the environment (D783, D797): there is no
// `CAMSTACK_JWT_SECRET`, `CAMSTACK_ADMIN_USER` or `CAMSTACK_ADMIN_PASS` here.
const ENV_VAR_MAP: Record<string, string> = {
  CAMSTACK_PORT: 'server.port',
  CAMSTACK_HOST: 'server.host',
  CAMSTACK_DATA: 'server.dataPath',
}

/**
 * Built-in defaults with the environment applied — THE bootstrap loader: the
 * hub's `main.ts` and `ConfigManager` come through here, so a key is read in one
 * place. There is no config.yaml (D1018); the one release of transition for a
 * node that still has one lives in `legacy-config-yaml.ts`.
 */
export function loadBootstrapConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BootstrapConfig {
  const fromEnv = applyEnvOverrides({}, env)
  const envServer = isRecord(fromEnv['server']) ? fromEnv['server'] : {}
  const legacy = reconcileLegacyConfigYaml(env, bootstrapSchema.parse(fromEnv).server)
  logLegacyNotes(legacy.notes)
  // The overrides are only for keys whose env var is unset, so the order is moot.
  return bootstrapSchema.parse({ server: { ...envServer, ...legacy.overrides } })
}

/**
 * Deep-set a value in a nested plain object using a dot-notation path.
 * Returns a new object (immutable).
 */
function setNested(
  obj: Record<string, unknown>,
  configPath: string,
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = configPath.split('.')
  if (!head) return obj
  if (rest.length === 0) {
    return { ...obj, [head]: value }
  }
  const existing = obj[head]
  const child = isRecord(existing) ? existing : {}
  return { ...obj, [head]: setNested(child, rest.join('.'), value) }
}

/**
 * Apply env var overrides onto the raw object.
 * Only bootstrap-level env vars are applied.
 */
function applyEnvOverrides(
  raw: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, unknown> {
  let result = { ...raw }

  for (const [envKey, configPath] of Object.entries(ENV_VAR_MAP)) {
    const envValue = env[envKey]
    if (envValue === undefined || envValue === '') continue

    // Coerce to number for known numeric fields
    const coerced: unknown = configPath === 'server.port' ? Number(envValue) : envValue
    result = setNested(result, configPath, coerced)
    console.log(`[ConfigManager] Env override applied: ${envKey} → ${configPath}`)
  }

  return result
}
