/**
 * config.yaml + env: loading, the section writer and the legacy `raw` view —
 * `ConfigManager`'s bootstrap layer, split out of `config-manager.ts` (D675)
 * so that file stays one class. The `console.*` calls are the documented
 * residuals described on `ConfigManager` (no logger exists yet at boot).
 */
import * as fs from 'node:fs'
import { asJsonObject } from '@camstack/types/addon'
import * as yaml from 'js-yaml'
import {
  type AppConfig,
  type BootstrapConfig,
  bootstrapSchema,
  RUNTIME_DEFAULTS,
} from './config-schema.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Sections that live in config.yaml. Everything else goes to the settings-store. */
const BOOTSTRAP_SECTIONS = new Set(['server', 'auth', 'mode'])

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
  CAMSTACK_CORS_ORIGINS: 'server.corsOrigins',
}

/** config.yaml, env overrides applied, parsed. */
export function loadBootstrapConfig(configPath: string): BootstrapConfig {
  const merged = applyEnvOverrides(asJsonObject(loadYaml(configPath)) ?? {})
  return bootstrapSchema.parse(merged)
}

export function writeBootstrapSection(
  configPath: string,
  section: string,
  data: Record<string, unknown>,
): BootstrapConfig {
  if (!BOOTSTRAP_SECTIONS.has(section)) {
    throw new Error(
      `[ConfigManager] Section "${section}" is a runtime setting — use setSection() to persist via the settings-store, not update() which writes to config.yaml`,
    )
  }

  // Load latest raw YAML to avoid overwriting concurrent changes
  let raw: Record<string, unknown> = {}
  if (fs.existsSync(configPath)) {
    const parsed: unknown = yaml.load(fs.readFileSync(configPath, 'utf-8'))
    raw = asJsonObject(parsed) ?? {}
  }

  // Shallow merge within the section
  const existing = asJsonObject(raw[section]) ?? {}
  raw[section] = { ...existing, ...data }

  // Validate bootstrap sections
  const validation = bootstrapSchema.safeParse(raw)
  if (!validation.success) {
    throw new Error(
      `[ConfigManager] Invalid config update for section "${section}": ${validation.error.message}`,
    )
  }

  // Atomic write: temp file -> rename
  const tmpPath = `${configPath}.tmp`
  fs.writeFileSync(
    tmpPath,
    yaml.dump(raw, { lineWidth: 120, indent: 2, quotingType: '"' }),
    'utf-8',
  )
  fs.renameSync(tmpPath, configPath)

  return validation.data
}

/**
 * Returns a merged view of bootstrap config + runtime defaults for backward compat.
 */
export function buildRawAppConfig(bootstrapConfig: BootstrapConfig): AppConfig {
  const features: AppConfig['features'] = {
    streaming: RUNTIME_DEFAULTS['features.streaming'],
    notifications: RUNTIME_DEFAULTS['features.notifications'],
    objectDetection: RUNTIME_DEFAULTS['features.objectDetection'],
    remoteAccess: RUNTIME_DEFAULTS['features.remoteAccess'],
    agentCluster: RUNTIME_DEFAULTS['features.agentCluster'],
    smartHome: RUNTIME_DEFAULTS['features.smartHome'],
    recordings: RUNTIME_DEFAULTS['features.recordings'],
    backup: RUNTIME_DEFAULTS['features.backup'],
    repl: RUNTIME_DEFAULTS['features.repl'],
  }
  return {
    ...bootstrapConfig,
    features,
    storage: {
      provider: RUNTIME_DEFAULTS['storage.provider'],
      locations: { ...RUNTIME_DEFAULTS['storage.locations'] },
    },
    logging: {
      level: RUNTIME_DEFAULTS['logging.level'],
      retentionDays: RUNTIME_DEFAULTS['logging.retentionDays'],
    },
    eventBus: {
      ringBufferSize: RUNTIME_DEFAULTS['eventBus.ringBufferSize'],
    },
    retention: {
      detectionEventsDays: RUNTIME_DEFAULTS['retention.detectionEventsDays'],
      audioLevelsDays: RUNTIME_DEFAULTS['retention.audioLevelsDays'],
    },
    providers: [...RUNTIME_DEFAULTS['providers']],
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
