export const HF_REPO = 'camstack/camstack-models'
export const HF_BASE_URL = `https://huggingface.co/${HF_REPO}/resolve/main`

/**
 * The ONE default session-JWT lifetime.
 *
 * There used to be three, and they disagreed: the `system-config` schema said
 * `30d`, `RUNTIME_DEFAULTS['auth.tokenExpiry']` said `7d`, and
 * `AuthManager.signToken` hardcoded `30d` as its own fallback. Because the
 * production signer (`AuthService extends AuthManager`, wired to
 * `ConfigManager`) resolves through `RUNTIME_DEFAULTS` BEFORE it can ever
 * reach the hardcoded fallback, the value actually in force was `7d` while
 * every surface an operator could read advertised `30d`.
 *
 * `30d` is the value the product documents and the one an operator decided on
 * (2026-07-17: the viewer's silent refresh rotates tokens long before expiry,
 * so a long lifetime only covers devices left unopened for weeks). It is
 * declared here once and imported by the schema, by the runtime defaults and
 * by the signer's fallback — a second default that disagrees with the first is
 * the same defect in miniature.
 */
export const DEFAULT_TOKEN_EXPIRY = '30d'

/**
 * Shape of {@link RUNTIME_DEFAULTS}. Every key/value is typed explicitly so
 * consumers (ConfigManager.raw, feature accessors, settings-store seeder)
 * can read fields without `as` casts.
 *
 * Iteration via `Object.entries` still yields `[string, RuntimeDefaultsShape[keyof RuntimeDefaultsShape]]`
 * which is assignable to `[string, unknown]` — no change for consumers that
 * only need the iteration behaviour.
 */
export interface RuntimeDefaultsProvider {
  id: string
  type: string
  name: string
}

export interface RuntimeDefaultsShape {
  /** Index signature for dynamic string-path lookups (e.g. ConfigManager.get).
   *  Explicit keys below override this with their precise types. */
  [key: string]: unknown
  'features.streaming': boolean
  'features.notifications': boolean
  'features.objectDetection': boolean
  'features.remoteAccess': boolean
  'features.agentCluster': boolean
  'features.smartHome': boolean
  'features.recordings': boolean
  'features.backup': boolean
  'features.repl': boolean
  'retention.detectionEventsDays': number
  'retention.audioLevelsDays': number
  'logging.level': string
  'logging.retentionDays': number
  'eventBus.ringBufferSize': number
  'storage.provider': string
  'storage.locations': Record<string, string>
  providers: RuntimeDefaultsProvider[]
  'ffmpeg.hwAccel': string
  'ffmpeg.threadCount': number
  'auth.tokenExpiry': string
}

/**
 * Runtime defaults -- used by ConfigManager.get() for backward compatibility
 * until Plan B wires all runtime settings to the system_settings SQL table.
 *
 * Moved from @camstack/system/config-schema to @camstack/types so that
 * @camstack/system can reference it without a cross-package kernel import.
 */
export const RUNTIME_DEFAULTS: RuntimeDefaultsShape = {
  'features.streaming': true,
  'features.notifications': true,
  'features.objectDetection': false,
  'features.remoteAccess': true,
  'features.agentCluster': false,
  'features.smartHome': true,
  'features.recordings': true,
  'features.backup': true,
  'features.repl': true,
  'retention.detectionEventsDays': 30,
  'retention.audioLevelsDays': 7,
  'logging.level': 'info',
  'logging.retentionDays': 30,
  'eventBus.ringBufferSize': 10000,
  'storage.provider': 'sqlite-storage',
  'storage.locations': {
    data: 'camstack-data/data',
    media: 'camstack-data/media',
    recordings: 'camstack-data/recordings',
    cache: '/tmp/camstack-cache',
    logs: 'camstack-data/logs',
    models: 'camstack-data/models',
  },
  providers: [],
  // Streaming ports are addon-specific (restreamer owns its defaults)
  // FFmpeg
  // No `ffmpeg.binaryPath`: the binary is the node's pinned build (D540),
  // resolved by `ensureFfmpeg`, never a runtime default naming PATH.
  'ffmpeg.hwAccel': 'auto',
  'ffmpeg.threadCount': 0,
  // Detection / motion / audio settings are owned by their respective addons
  // (pipeline-orchestrator, motion-wasm, audio-analyzer/classifier, detection-pipeline
  // step schemas). No detection defaults at this level.
  // Backup retention is addon-specific (local-backup owns its default)
  // Auth (runtime) — see DEFAULT_TOKEN_EXPIRY: one default, not three.
  'auth.tokenExpiry': DEFAULT_TOKEN_EXPIRY,
}
