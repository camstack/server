/**
 * The stream-broker's per-camera state, kept as per-device settings (D870).
 *
 * Three maps used to be collections of their own (`stream-broker:probe-snapshots`,
 * `:profile-map`, `:rtsp-tokens`), each keyed by the camera. A camera's data in
 * a side table is a row somebody must remember to delete when the camera goes;
 * as a KEY of the camera's own settings it is cleared by the central device
 * delete (D865) with everything else.
 *
 * | key              | value for one camera                                      |
 * | ---------------- | --------------------------------------------------------- |
 * | `probeSnapshots` | `{ [camStreamId]: ProbedSnapshot }` - what the broker last probed |
 * | `brokerProfile`  | `{ map, auto }` - the profile -> camStreamId assignment   |
 * | `rtspTokens`     | JSON text of `{ [camStreamId]: token }` - a SECRET: declared in `secretStatePaths`, so the settings view stores a keychain marker and the text lives in the keychain |
 *
 * Failure direction: a load that cannot ask the store THROWS (D49). The writers
 * built on {@link DeviceKeyMirror} refuse to write until a load has succeeded,
 * because a replace driven by an empty "known" set would otherwise drop or
 * shrink rows it never saw.
 */
import { z } from 'zod'
import { isSecretMarker, type IScopedLogger } from '@camstack/types'
import { ProbedSnapshotSchema } from './stream-broker/probed-summary.js'

/** Per-device settings keys. */
export const PROBE_SNAPSHOTS_KEY = 'probeSnapshots'
export const BROKER_PROFILE_KEY = 'brokerProfile'
export const RTSP_TOKENS_KEY = 'rtspTokens'

/** The slice of `ctx.settings` the broker persists through. */
export interface BrokerDeviceSettings {
  readDeviceStoreBatch(
    deviceIds: readonly number[],
  ): Promise<ReadonlyMap<number, Record<string, unknown>>>
  listDeviceStoreIds(): Promise<readonly number[]>
  writeDeviceStore(deviceId: number, patch: Record<string, unknown>): Promise<void>
}

/** One camera's profile -> camStreamId assignment, plus whether it is automatic. */
export const ProfileAssignmentSchema = z.object({
  map: z.record(z.string(), z.string()),
  auto: z.boolean(),
})
export type ProfileAssignment = z.infer<typeof ProfileAssignmentSchema>

export const ProbeSnapshotsOfDeviceSchema = z.record(z.string(), ProbedSnapshotSchema)
export type ProbeSnapshotsOfDevice = z.infer<typeof ProbeSnapshotsOfDeviceSchema>

export const RtspTokensOfDeviceSchema = z.record(z.string(), z.string().min(1))
export type RtspTokensOfDevice = z.infer<typeof RtspTokensOfDeviceSchema>

/**
 * A broker id is `<deviceId>/<camStreamId>`. Returns `null` rather than
 * guessing: a key whose head is not a number is a key this addon did not
 * write, and inventing a device for it would put a value on a camera at random.
 */
export function splitBrokerId(
  brokerId: string,
): { readonly deviceId: number; readonly camStreamId: string } | null {
  const slash = brokerId.indexOf('/')
  if (slash <= 0) return null
  const deviceId = Number(brokerId.slice(0, slash))
  if (!Number.isInteger(deviceId) || deviceId <= 0) return null
  return { deviceId, camStreamId: brokerId.slice(slash + 1) }
}

/** Group `<deviceId>/<camStreamId>` -> value into deviceId -> camStreamId -> value. */
export function groupByDevice<V>(
  flat: Readonly<Record<string, V>> | ReadonlyMap<string, V>,
): Map<number, Record<string, V>> {
  const entries = flat instanceof Map ? [...flat.entries()] : Object.entries(flat)
  const out = new Map<number, Record<string, V>>()
  for (const [brokerId, value] of entries) {
    const parts = splitBrokerId(brokerId)
    if (parts === null) continue
    const group = out.get(parts.deviceId) ?? {}
    group[parts.camStreamId] = value
    out.set(parts.deviceId, group)
  }
  return out
}

/** The inverse of {@link groupByDevice}. */
export function flattenByDevice<V>(
  grouped: ReadonlyMap<number, Readonly<Record<string, V>>>,
): Map<string, V> {
  const out = new Map<string, V>()
  for (const [deviceId, group] of grouped) {
    for (const [camStreamId, value] of Object.entries(group)) {
      out.set(`${deviceId}/${camStreamId}`, value)
    }
  }
  return out
}

/** A stored value that exists but cannot be read now (see `DeviceKeyMirrorDeps.decode`). */
export const HELD_UNAVAILABLE: unique symbol = Symbol('held-unavailable')

export interface DeviceKeyMirrorDeps<T> {
  readonly settings: BrokerDeviceSettings
  readonly key: string
  readonly logger: IScopedLogger
  /**
   * Stored form -> value. `null` marks a value that does not parse (skipped,
   * said aloud); {@link HELD_UNAVAILABLE} marks a value that EXISTS but cannot
   * be read right now (a keychain marker the keychain did not resolve). The
   * camera is BLOCKED: every other camera loads and is served, but nothing is
   * ever written for the blocked one - treating it as absent is how a minted
   * replacement overwrites the real thing.
   */
  readonly decode: (stored: unknown) => T | null | typeof HELD_UNAVAILABLE
  /** Value -> stored form. */
  readonly encode: (value: T) => unknown
}

/**
 * One settings key across the fleet: loaded once, then written by diff.
 *
 * `replace` is authoritative (a camera the caller no longer holds loses the
 * key, but only if this mirror has SEEN it - it never deletes what it did not
 * load); `merge` only ever adds and changes.
 */
export class DeviceKeyMirror<T> {
  private readonly deps: DeviceKeyMirrorDeps<T>
  /** The JSON of what the store holds per device, as of the last load or write. */
  private readonly held = new Map<number, string>()
  private readonly values = new Map<number, T>()
  private readonly blocked = new Map<number, unknown>()
  /** Cameras whose stored value is GONE: a load never re-blocks them. */
  private readonly released = new Set<number>()
  private loaded = false

  constructor(deps: DeviceKeyMirrorDeps<T>) {
    this.deps = deps
  }

  /** Read the key of every camera that has it. THROWS when the store cannot be asked. */
  async load(): Promise<ReadonlyMap<number, T>> {
    const ids = await this.deps.settings.listDeviceStoreIds()
    const blobs = await this.deps.settings.readDeviceStoreBatch(ids)
    const out = new Map<number, T>()
    this.held.clear()
    this.values.clear()
    this.loaded = false
    this.blocked.clear()
    for (const [deviceId, blob] of blobs) {
      const stored = blob[this.deps.key]
      if (stored === undefined) continue
      const value = this.deps.decode(stored)
      if (value === HELD_UNAVAILABLE) {
        if (!this.released.has(deviceId)) this.blocked.set(deviceId, stored)
        continue
      }
      if (value === null) {
        this.deps.logger.warn('broker device state skipped - it does not parse', {
          tags: { deviceId },
          meta: { key: this.deps.key },
        })
        continue
      }
      out.set(deviceId, value)
      this.values.set(deviceId, value)
      this.held.set(deviceId, JSON.stringify(this.deps.encode(value)))
    }
    this.loaded = true
    return out
  }

  /** Cameras whose stored value exists but could not be read: never written, never replaced. */
  heldDevices(): ReadonlyMap<number, unknown> {
    return this.blocked
  }

  /**
   * Stop protecting a camera whose stored value is GONE (the secret was deleted
   * or the keychain restored without it): there is nothing left to overwrite.
   */
  release(deviceId: number): void {
    this.blocked.delete(deviceId)
    this.released.add(deviceId)
  }

  /** Is this camera's token write (and restream URL) blocked right now? */
  isBlocked(deviceId: number): boolean {
    return this.blocked.has(deviceId)
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error(`broker device state "${this.deps.key}" was never loaded - refusing to write`)
    }
  }

  private async writeChanged(next: ReadonlyMap<number, T>): Promise<number> {
    let written = 0
    for (const [deviceId, value] of next) {
      if (this.blocked.has(deviceId)) continue
      const encoded = this.deps.encode(value)
      const text = JSON.stringify(encoded)
      if (this.held.get(deviceId) === text) continue
      await this.deps.settings.writeDeviceStore(deviceId, { [this.deps.key]: encoded })
      this.held.set(deviceId, text)
      this.values.set(deviceId, value)
      written += 1
    }
    return written
  }

  /** Make the store hold exactly `next` for the cameras this mirror knows. */
  async replace(next: ReadonlyMap<number, T>): Promise<{ written: number; removed: number }> {
    this.assertLoaded()
    const written = await this.writeChanged(next)
    let removed = 0
    for (const deviceId of [...this.held.keys()]) {
      if (next.has(deviceId) || this.blocked.has(deviceId)) continue
      await this.deps.settings.writeDeviceStore(deviceId, { [this.deps.key]: undefined })
      this.held.delete(deviceId)
      this.values.delete(deviceId)
      removed += 1
    }
    return { written, removed }
  }

  /** Add or change; never remove. */
  async merge(next: ReadonlyMap<number, T>): Promise<number> {
    this.assertLoaded()
    return this.writeChanged(next)
  }

  /** Drop one camera's key (a device that changed hardware under its number). */
  async remove(deviceId: number): Promise<boolean> {
    this.assertLoaded()
    if (!this.held.has(deviceId) || this.blocked.has(deviceId)) return false
    await this.deps.settings.writeDeviceStore(deviceId, { [this.deps.key]: undefined })
    this.held.delete(deviceId)
    this.values.delete(deviceId)
    return true
  }

  /** What the store holds for the camera as of the last load or write. */
  current(deviceId: number): T | undefined {
    return this.values.get(deviceId)
  }

  /** Whether a load has answered; a writer that was never loaded refuses. */
  get isLoaded(): boolean {
    return this.loaded
  }
}

function parseWith<T>(schema: z.ZodType<T>): (stored: unknown) => T | null {
  return (stored) => {
    const parsed = schema.safeParse(stored)
    return parsed.success ? parsed.data : null
  }
}

export function probeSnapshotsMirror(
  settings: BrokerDeviceSettings,
  logger: IScopedLogger,
): DeviceKeyMirror<ProbeSnapshotsOfDevice> {
  return new DeviceKeyMirror({
    settings,
    key: PROBE_SNAPSHOTS_KEY,
    logger,
    decode: parseWith(ProbeSnapshotsOfDeviceSchema),
    encode: (value) => value,
  })
}

export function profileMapMirror(
  settings: BrokerDeviceSettings,
  logger: IScopedLogger,
): DeviceKeyMirror<ProfileAssignment> {
  return new DeviceKeyMirror({
    settings,
    key: BROKER_PROFILE_KEY,
    logger,
    decode: parseWith(ProfileAssignmentSchema),
    encode: (value) => value,
  })
}

/** The tokens of one camera are ONE keychain-held text: JSON of `{ camStreamId: token }`. */
export function rtspTokensMirror(
  settings: BrokerDeviceSettings,
  logger: IScopedLogger,
): DeviceKeyMirror<RtspTokensOfDevice> {
  return new DeviceKeyMirror({
    settings,
    key: RTSP_TOKENS_KEY,
    logger,
    decode: (stored) => {
      // A marker the keychain did not resolve is a token set that EXISTS.
      if (isSecretMarker(stored)) return HELD_UNAVAILABLE
      if (typeof stored !== 'string') return null
      try {
        const parsed = RtspTokensOfDeviceSchema.safeParse(JSON.parse(stored))
        return parsed.success ? parsed.data : null
      } catch {
        // Not JSON: either corrupt, or a keychain marker that could not be
        // resolved (locked). Neither is a token set.
        return null
      }
    },
    encode: (value) => JSON.stringify(value),
  })
}

/**
 * Fold freshly minted tokens (`<deviceId>/<camStreamId>` -> token) into what
 * each camera already holds. Only ever adds or changes: a token is stable
 * forever per stream unless explicitly regenerated.
 */
export function mergeRtspTokens(
  mirror: Pick<DeviceKeyMirror<RtspTokensOfDevice>, 'current'>,
  minted: ReadonlyMap<string, string>,
): Map<number, RtspTokensOfDevice> {
  const out = new Map<number, RtspTokensOfDevice>()
  for (const [deviceId, group] of groupByDevice(minted)) {
    out.set(deviceId, { ...mirror.current(deviceId), ...group })
  }
  return out
}
