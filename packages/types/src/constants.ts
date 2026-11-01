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
 * consumers (ConfigManager, the settings-store seeder) can read fields without
 * `as` casts.
 */
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
  'auth.tokenExpiry': string
}

/**
 * Runtime defaults — what `ConfigManager.get()` answers for a key nothing has
 * stored, and what the settings store seeds on first boot. Only keys somebody
 * READS are here: `features.*` (served as `system.info`) and `auth.tokenExpiry`. The flat `retention.*`, `logging.*`, `storage.*`,
 * `ffmpeg.*`, `providers` and `eventBus.ringBufferSize` defaults had no reader
 * and were deleted (#342).
 */
export const RUNTIME_DEFAULTS: RuntimeDefaultsShape = {
  // Still read: `ConfigManager.features` → `FeatureManager` → `system.info` / `system.featureFlags`.
  'features.streaming': true,
  'features.notifications': true,
  'features.objectDetection': false,
  'features.remoteAccess': true,
  'features.agentCluster': false,
  'features.smartHome': true,
  'features.recordings': true,
  'features.backup': true,
  'features.repl': true,
  // Auth (runtime) — see DEFAULT_TOKEN_EXPIRY: one default, not three.
  'auth.tokenExpiry': DEFAULT_TOKEN_EXPIRY,
}
