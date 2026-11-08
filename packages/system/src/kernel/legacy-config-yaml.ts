/**
 * TRANSITION — delete this module, its spec and the `js-yaml` dependency one
 * release after it ships (D1018).
 *
 * CamStack no longer has a `config.yaml`: the bootstrap config is the
 * environment plus built-in defaults. A node updated from a release that still
 * had the file must not change port, host or data directory silently, so for
 * ONE release the file is parsed here, only to compare: a key whose legacy value
 * differs from the effective env/default value, and whose environment variable
 * is not set, is still applied, with a warning naming the variable that
 * replaces it. A file that matches the defaults is ignored.
 *
 * Like `bootstrap-config.ts`, this runs before any logger exists, so the
 * `console.*` calls are the documented residual (see `ConfigManager`).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { asJsonObject } from '@camstack/types/addon'
import * as yaml from 'js-yaml'
import { DEFAULT_DATA_PATH } from './config-schema.js'

/** The former image default, searched after `CONFIG_PATH` so a recreated container still finds its volume. */
const FORMER_IMAGE_CONFIG_PATH = '/config/config.yaml'

/** The bootstrap keys a legacy file could still set, with the variable that now owns each. */
const LEGACY_KEYS = [
  { key: 'port', envVar: 'CAMSTACK_PORT' },
  { key: 'host', envVar: 'CAMSTACK_HOST' },
  { key: 'dataPath', envVar: 'CAMSTACK_DATA' },
] as const

export type LegacyBootstrapKey = (typeof LEGACY_KEYS)[number]['key']

/** The effective value of each key, from env and defaults, before the legacy file is consulted. */
export interface EffectiveBootstrapValues {
  readonly port: number
  readonly host: string
  readonly dataPath: string
}

export interface LegacyNote {
  readonly level: 'info' | 'warn'
  readonly message: string
}

export interface LegacyConfigYamlResult {
  /** Values to apply under the environment: only keys whose env var is unset and whose legacy value differs. */
  readonly overrides: Partial<EffectiveBootstrapValues>
  readonly notes: readonly LegacyNote[]
}

const NOTHING_TO_APPLY: LegacyConfigYamlResult = { overrides: {}, notes: [] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnvSet(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const value = env[name]
  return value !== undefined && value !== ''
}

/** Where the legacy file would be: `CONFIG_PATH`, the former image default, then under the data root. */
export function legacyConfigYamlCandidates(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const dataRoot = isEnvSet(env, 'CAMSTACK_DATA')
    ? (env['CAMSTACK_DATA'] ?? DEFAULT_DATA_PATH)
    : path.join(process.cwd(), DEFAULT_DATA_PATH)
  return [
    ...(isEnvSet(env, 'CONFIG_PATH') ? [env['CONFIG_PATH'] ?? ''] : []),
    FORMER_IMAGE_CONFIG_PATH,
    path.join(dataRoot, 'config.yaml'),
  ]
}

function findLegacyFile(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return legacyConfigYamlCandidates(env).find((candidate) => fs.existsSync(candidate))
}

/** The legacy value of a key when it is well-formed, else undefined. */
function legacyValue(server: Record<string, unknown>, key: LegacyBootstrapKey): unknown {
  const value = server[key]
  if (key === 'port') {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536
      ? value
      : undefined
  }
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Retired-key notices the file used to earn at boot; they leave with the file. */
function retiredKeyNotes(raw: Record<string, unknown>): readonly LegacyNote[] {
  const notes: LegacyNote[] = []
  const section = raw['bootstrap']
  if (isRecord(section) && 'installSource' in section) {
    notes.push({
      level: 'warn',
      message:
        'bootstrap.installSource ignored — addons always install from npm; ' +
        'a workspace build reaches a node through `camstack deploy`.',
    })
  }
  if (isRecord(section) && 'requiredAddons' in section) {
    notes.push({
      level: 'warn',
      message:
        'bootstrap.requiredAddons ignored — the first-boot addon set always comes from the server package.',
    })
  }
  const keychain = raw['keychain']
  if (isRecord(keychain) && ('keyFile' in keychain || 'previousKeyFile' in keychain)) {
    notes.push({
      level: 'warn',
      message:
        'keychain.keyFile / keychain.previousKeyFile ignored — the external master key is a fixed ' +
        'mounted path: mount the file at /run/secrets/camstack-master-key (the key being rotated ' +
        'away from at /run/secrets/camstack-master-key.previous).',
    })
  }
  return notes
}

/**
 * Compare a legacy config.yaml, if one exists, with what env and defaults give.
 * Pure of side effects except for reading the file.
 */
export function reconcileLegacyConfigYaml(
  env: Readonly<Record<string, string | undefined>>,
  effective: EffectiveBootstrapValues,
): LegacyConfigYamlResult {
  const file = findLegacyFile(env)
  if (file === undefined) return NOTHING_TO_APPLY

  let raw: Record<string, unknown>
  try {
    raw = asJsonObject(yaml.load(fs.readFileSync(file, 'utf-8'))) ?? {}
  } catch (err) {
    return {
      overrides: {},
      notes: [
        {
          level: 'warn',
          message: `${file} could not be parsed (${err instanceof Error ? err.message : String(err)}) and is ignored — config.yaml is no longer read. Delete it.`,
        },
      ],
    }
  }

  const serverRaw = raw['server']
  const server = isRecord(serverRaw) ? serverRaw : {}
  const overrides: { port?: number; host?: string; dataPath?: string } = {}
  const notes: LegacyNote[] = [...retiredKeyNotes(raw)]

  for (const { key, envVar } of LEGACY_KEYS) {
    if (isEnvSet(env, envVar)) continue
    const legacy = legacyValue(server, key)
    if (legacy === undefined || legacy === effective[key]) continue
    if (key === 'port' && typeof legacy === 'number') overrides.port = legacy
    else if (key === 'host' && typeof legacy === 'string') overrides.host = legacy
    else if (key === 'dataPath' && typeof legacy === 'string') overrides.dataPath = legacy
    notes.push({
      level: 'warn',
      message: `${file} is no longer read, but sets server.${key}=${String(legacy)}, still applied for this release: set ${envVar}=${String(legacy)} and delete ${file}.`,
    })
  }

  if (!notes.some((n) => n.level === 'warn')) {
    notes.push({
      level: 'info',
      message: `${file} is no longer read and matches the defaults: it can be deleted.`,
    })
  }
  return { overrides, notes }
}

/** Notes already printed by this process: the loader runs twice per boot (main.ts and ConfigManager). */
const printedNotes = new Set<string>()

/** Print each note once per process, the way the bootstrap prints everything else. */
export function logLegacyNotes(notes: readonly LegacyNote[]): void {
  for (const note of notes) {
    const id = `${note.level}:${note.message}`
    if (printedNotes.has(id)) continue
    printedNotes.add(id)
    if (note.level === 'warn') console.warn(`[Phase1] WARN ${note.message}`)
    else console.log(`[Phase1] ${note.message}`)
  }
}
