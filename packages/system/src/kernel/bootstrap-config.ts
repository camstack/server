/**
 * config.yaml + env: loading —
 * `ConfigManager`'s bootstrap layer, split out of `config-manager.ts` (D675)
 * so that file stays one class. The `console.*` calls are the documented
 * residuals described on `ConfigManager` (no logger exists yet at boot).
 */
import * as fs from 'node:fs'
import { asJsonObject } from '@camstack/types/addon'
import * as yaml from 'js-yaml'
import { type BootstrapConfig, bootstrapSchema } from './config-schema.js'

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
 * config.yaml, env overrides applied, parsed — THE bootstrap loader: the hub's
 * `main.ts` and `ConfigManager` come through here, so a key is
 * read in one place. Keys the schema does not name are stripped, not read.
 */
export function loadBootstrapConfig(
  configPath: string,
  options: { readonly warnRetiredKeys?: boolean } = {},
): BootstrapConfig {
  const raw = asJsonObject(loadYaml(configPath)) ?? {}
  if (options.warnRetiredKeys === true) warnRetiredYamlKeys(raw)
  return bootstrapSchema.parse(applyEnvOverrides(raw))
}

/**
 * A yaml key that no longer exists is stripped by the schema; this names it
 * once so an operator who still carries it is told. Addons always come from
 * npm — a workspace build reaches a node through `camstack deploy`.
 */
function warnRetiredYamlKeys(raw: Record<string, unknown>): void {
  const section = raw['bootstrap']
  if (isRecord(section) && 'installSource' in section) {
    console.warn(
      '[Phase1] WARN bootstrap.installSource ignored — addons always install from npm; ' +
        'a workspace build reaches a node through `camstack deploy`. Remove the key.',
    )
  }
  const keychain = raw['keychain']
  if (isRecord(keychain) && ('keyFile' in keychain || 'previousKeyFile' in keychain)) {
    console.warn(
      '[Phase1] WARN keychain.keyFile / keychain.previousKeyFile ignored — the external ' +
        'master key is a fixed mounted path: mount the file at /run/secrets/camstack-master-key ' +
        '(the key being rotated away from at /run/secrets/camstack-master-key.previous). ' +
        'Remove the keys.',
    )
  }
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
 * Apply env var overrides onto the raw YAML object.
 * Only bootstrap-level env vars are applied.
 */
function applyEnvOverrides(raw: Record<string, unknown>): Record<string, unknown> {
  let result = { ...raw }

  for (const [envKey, configPath] of Object.entries(ENV_VAR_MAP)) {
    const envValue = process.env[envKey]
    if (envValue === undefined || envValue === '') continue

    // Coerce to number for known numeric fields
    const coerced: unknown = configPath === 'server.port' ? Number(envValue) : envValue
    result = setNested(result, configPath, coerced)
    console.log(`[ConfigManager] Env override applied: ${envKey} → ${configPath}`)
  }

  return result
}

function loadYaml(configPath: string): unknown {
  if (!fs.existsSync(configPath)) {
    console.warn(
      `[ConfigManager] Config file not found at: ${configPath}\n` +
        `  → Using built-in defaults. Set CONFIG_PATH env var or create the file.\n` +
        `  → Example path from project root: ./server/backend/data/config.yaml`,
    )
    return {}
  }

  const content = fs.readFileSync(configPath, 'utf-8')
  const parsed = yaml.load(content) ?? {}
  console.log(`[ConfigManager] Loaded config from: ${configPath}`)
  return parsed
}
