/**
 * Pure helpers for the per-entry ONBOARD broker feature.
 *
 * An onboard broker is an {@link OnboardBrokerEntry} — an external broker
 * entry that additionally carries an `onboard: { port, allowAnonymous }`
 * descriptor. When present, the addon OWNS a dedicated `aedes` server for
 * that entry (one server per entry id), listening on `127.0.0.1:<port>`.
 *
 * These functions are intentionally side-effect-free so they can be unit
 * tested in isolation from the addon runtime (which needs an
 * `AddonContext`).
 */

/** Onboard descriptor attached to an external broker entry. */
export interface OnboardDescriptor {
  readonly port: number
  readonly allowAnonymous: boolean
}

/**
 * Minimal shape of an external broker entry as far as the onboard helpers
 * care about it. Kept structural (not importing the addon's full
 * `ExternalBrokerEntry`) so this module stays dependency-free and testable.
 */
export interface OnboardBrokerEntry {
  readonly id: string
  readonly name: string
  readonly username?: string
  /** Password — the resolved keychain value. */
  readonly password?: string
  readonly onboard: OnboardDescriptor
}

/**
 * Embedded-broker descriptor the `aedes` spawn path consumes. Mirrors the
 * addon's internal `EmbeddedBrokerEntry` shape (structural compatibility,
 * not a nominal import — kept in sync by the addon's own type at the call
 * site).
 */
export interface EmbeddedSpawnEntry {
  readonly id: string
  readonly name: string
  readonly port: number
  readonly allowAnonymous: boolean
  readonly username?: string
  readonly password?: string
}

/**
 * Map an onboard {@link OnboardBrokerEntry} onto the
 * {@link EmbeddedSpawnEntry} the `aedes` spawn path expects. Pure — builds a
 * new object, never mutates the input.
 *
 * - id / name come from the entry.
 * - port / allowAnonymous come from `entry.onboard`.
 * - username / password are carried through ONLY when present,
 *   so the spawned broker's legacy-credentials auth branch sees them.
 */
export function onboardToEmbeddedEntry(entry: OnboardBrokerEntry): EmbeddedSpawnEntry {
  return {
    id: entry.id,
    name: entry.name,
    port: entry.onboard.port,
    allowAnonymous: entry.onboard.allowAnonymous,
    ...(entry.username !== undefined ? { username: entry.username } : {}),
    ...(entry.password !== undefined ? { password: entry.password } : {}),
  }
}

/** The id + desired port of an onboard entry that SHOULD be running. */
export interface DesiredOnboard {
  readonly id: string
  readonly port: number
}

/** Result of reconciling desired onboard entries against running runtimes. */
export interface OnboardReconcilePlan {
  /** Entry ids with no running runtime — spawn them. */
  readonly toStart: readonly string[]
  /** Running runtime ids whose entry disappeared — shut them down. */
  readonly toStop: readonly string[]
  /** Entry ids whose desired port differs from the running port — restart. */
  readonly toRespawn: readonly string[]
}

/**
 * Decide which onboard runtimes to start, stop, or respawn.
 *
 * @param desiredEntries onboard entries that should be running (from config).
 * @param runningIds ids of currently-running onboard runtimes.
 * @param portById desired→running port lookup for currently-running runtimes.
 *
 * Pure: derives the plan purely from its inputs, builds fresh arrays.
 */
export function diffOnboardRuntimes(
  desiredEntries: readonly DesiredOnboard[],
  runningIds: readonly string[],
  portById: ReadonlyMap<string, number>,
): OnboardReconcilePlan {
  const runningSet = new Set(runningIds)
  const desiredById = new Map<string, number>()
  for (const d of desiredEntries) desiredById.set(d.id, d.port)

  const toStart: string[] = []
  const toRespawn: string[] = []
  for (const d of desiredEntries) {
    if (!runningSet.has(d.id)) {
      toStart.push(d.id)
      continue
    }
    const runningPort = portById.get(d.id)
    if (runningPort !== undefined && runningPort !== d.port) {
      toRespawn.push(d.id)
    }
  }

  const toStop: string[] = []
  for (const id of runningIds) {
    if (!desiredById.has(id)) toStop.push(id)
  }

  return { toStart, toStop, toRespawn }
}

/** Result of building an onboard entry from `broker.add` settings. */
export interface BuiltOnboardEntry {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly username?: string
  /** The password as supplied — the addon's settings save stores it in the keychain. */
  readonly password?: string
  readonly onboard: OnboardDescriptor
}

/**
 * Is `settings.onboard` truthy? Reads the loosely-typed settings bag with
 * `typeof` narrowing (no casts).
 */
export function isOnboardRequested(settings: Record<string, unknown>): boolean {
  return settings['onboard'] === true
}

/**
 * Read `settings.port` as a valid TCP port (1..65535) or return null when
 * absent / invalid — caller auto-allocates a free port in that case.
 */
export function readOnboardPort(settings: Record<string, unknown>): number | null {
  const raw = settings['port']
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null
  if (raw < 1 || raw > 65535) return null
  return raw
}

/**
 * Build an onboard {@link BuiltOnboardEntry} from `broker.add` settings.
 * Pure — the port is pre-resolved by the caller (auto-allocation is a
 * side-effecting concern kept out of this helper), so the helper performs no
 * I/O of its own.
 *
 * - url is derived as `mqtt://127.0.0.1:<port>`.
 * - allowAnonymous defaults to false when absent / non-boolean.
 * - username / password carried through only when present. The password is
 *   plaintext here: the settings save path puts it in the keychain (D787).
 */
export function buildOnboardEntry(args: {
  readonly id: string
  readonly name: string
  readonly port: number
  readonly settings: Record<string, unknown>
}): BuiltOnboardEntry {
  const { id, name, port, settings } = args
  const allowAnonymous = settings['allowAnonymous'] === true
  const username = typeof settings['username'] === 'string' ? settings['username'] : undefined
  const password = typeof settings['password'] === 'string' ? settings['password'] : undefined
  return {
    id,
    name,
    url: `mqtt://127.0.0.1:${port}`,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    onboard: { port, allowAnonymous },
  }
}
