/**
 * WHO a device id is — the mirrored directory the system-event intake reads.
 *
 * The intake has to answer two questions about a `device.offline` before it can
 * turn it into a notification: what is this device CALLED, and what TYPE is it
 * (the fact a rule's `deviceTypes` condition is judged against). Both are
 * properties of the device, not of the event, and neither may be fetched on the
 * event path: D49 says a one-shot event never gates on a fallible read, and a
 * per-event `getDevice` would put an RPC in front of every liveness flip on the
 * hub (sixteen of them arrived inside one second on 2026-08-12).
 *
 * So the answers are mirrored in memory and refreshed OFF the event path — at
 * boot, and on the same rule-reload tick that re-reads rules, texts and gated
 * device states (D8: reconcile on a schedule, never trust an event to arrive).
 *
 * ── Failure policy, and why it is the opposite of `NcDeviceStateCache` ──────
 *
 * The state cache gates whether a rule may FIRE, so a stale entry keeps a rule
 * armed on a condition that stopped being true — it ages out, and unknown never
 * matches. This directory supplies a NAME and a TYPE. Dropping it on one
 * transient error would strip the type off every liveness event, and a
 * type-narrowed rule fails closed — which would silence every "my cameras went
 * offline" notification on the hub. A name a minute out of date is the quiet,
 * harmless failure; so a failed refresh KEEPS the previous snapshot
 * indefinitely, and logs that it did.
 *
 * A COLD directory (before the first successful refresh) knows nothing. An
 * event about an id it cannot place still becomes a notification — named by its
 * id — but carries NO type, so a rule that asked for cameras does not claim it.
 * Unknown is never evidence of a camera: the flood this module exists to stop
 * was sixteen notifications about a smart plug.
 */

import { DeviceType, type IScopedLogger } from '@camstack/types'

/** One device, as the notification path needs to know it. */
export interface NcDeviceIdentity {
  readonly deviceId: number
  /** `DeviceType` value, verbatim — carried so a discard line can say WHAT the
   *  device was ("not-a-camera, deviceType=switch"). */
  readonly type: string
  /** Display name. May be empty — the caller falls back to the id. */
  readonly name: string
  /** The device-manager's own answer (it exposes stream sources). */
  readonly isCamera: boolean
  /**
   * Liveness and the detection wrapper, mirrored for the ALARM's coverage
   * answer — "Away armed, 12 cameras" is false if three of them are offline.
   *
   * Both are `undefined` when this hub has not supplied them (an older wiring,
   * or a projection that did not carry them), and `undefined` is never an
   * exclusion. Only an explicit `false` is a switch somebody turned off — the
   * alternative would report a cold mirror as a hub with no protection at all.
   * The authorities are the device manager's `online` flag and the presence of
   * a wrapped `detection-pipeline` binding (D62: read the authority, never a
   * second copy of it).
   */
  readonly online?: boolean
  readonly detectionActive?: boolean
  /**
   * The device this one hangs off, or `null` for a FIRST-LEVEL device.
   *
   * Carried for exactly one decision — {@link isAccessoryIdentity} — and it is
   * a decision about noise, not about identity. `undefined` means this hub did
   * not supply the field (an older wiring, a projection that predates it) and
   * is deliberately NOT read as "accessory": a directory that cannot answer
   * must never silence the fleet.
   */
  readonly parentDeviceId?: number | null
  /**
   * The operator's LOCATION label (room / area), `null` when unset, `undefined` when this hub
   * did not supply it. Read by the alarm's intrusion title (D706), which falls back to the
   * device name — never to an empty word.
   */
  readonly location?: string | null
}

/**
 * Is this device an ACCESSORY — something that hangs off another device?
 *
 * The one question the liveness intake asks before it words an outage. See
 * `__tests__/liveness-first-level-only.spec.ts` for the 100 devices this
 * predicate exists to keep quiet.
 *
 * Fails toward SPEAKING: an id the directory cannot place, and an identity with
 * no `parentDeviceId` field at all, are both first-level. A cold mirror that
 * answered "accessory" would silence every outage on the hub, which is the
 * failure this whole feature exists to avoid.
 */
export function isAccessoryIdentity(identity: NcDeviceIdentity | undefined): boolean {
  if (identity === undefined) return false
  const parent = identity.parentDeviceId
  return typeof parent === 'number'
}

/** The no-I/O read the intake holds. `undefined` = this hub knows no such id. */
export type NcDeviceLookup = (deviceId: number) => NcDeviceIdentity | undefined

/**
 * Is this identity a camera?
 *
 * TWO authorities agree here on purpose and neither is redundant: `isCamera` is
 * derived (the device exposes `getStreamSources`), `type` is declared. A camera
 * registered by a provider that has not probed its streams yet still has
 * `type: camera`, and neither fact alone survives that window. An id that is
 * absent from the directory is not a camera — fail closed.
 */
function isCameraIdentity(identity: NcDeviceIdentity | undefined): boolean {
  if (identity === undefined) return false
  return identity.isCamera || identity.type === DeviceType.Camera
}

/**
 * The display name for a device in a notification text, with the id as the
 * last resort. Never blank: a body reading "La camera  è offline" is the
 * placeholder-hole failure the text-catalog guard exists to prevent.
 */
export function deviceDisplayName(
  identity: NcDeviceIdentity | undefined,
  deviceId: number,
): string {
  const name = identity?.name.trim() ?? ''
  return name.length > 0 ? name : String(deviceId)
}

export interface NcDeviceDirectoryDeps {
  readonly logger: IScopedLogger
  /**
   * Every device this hub knows, as identities. A device that cannot be read
   * is simply absent — never present with an invented type.
   */
  readonly listDevices: () => Promise<readonly NcDeviceIdentity[]>
}

/**
 * What one {@link NcDeviceDirectory.refresh} was worth as EVIDENCE.
 *
 * Only `answered` is an answer about which devices exist. `empty` (the list
 * came back with nothing) is indistinguishable from a hub that has not finished
 * restoring its registry, and `failed` is no answer at all — the same rule the
 * dispatcher applies to an empty target catalog.
 */
export type NcDirectoryRefreshOutcome = 'answered' | 'empty' | 'failed'

export class NcDeviceDirectory {
  private devices: ReadonlyMap<number, NcDeviceIdentity> = new Map()
  private loadedOnce = false
  /** How many refreshes have ANSWERED (non-empty, successful). */
  private answered = 0
  /** The ids of the answer before the latest one — `null` until there are two. */
  private previousAnswer: ReadonlySet<number> | null = null
  private latestAnswer: ReadonlySet<number> | null = null

  constructor(private readonly deps: NcDeviceDirectoryDeps) {}

  /** Hot-path read. No I/O, no await — called per system event. */
  get(deviceId: number): NcDeviceIdentity | undefined {
    return this.devices.get(deviceId)
  }

  /** A bound {@link NcDeviceLookup} that always sees the CURRENT snapshot. */
  lookup(): NcDeviceLookup {
    return (deviceId: number) => this.get(deviceId)
  }

  /** How many devices the last successful refresh saw (0 while cold). */
  size(): number {
    return this.devices.size
  }

  /**
   * Every identity in the current snapshot.
   *
   * Exists for the ONE caller that needs the whole directory rather than one
   * id: the liveness ledger's boot seed, which has to know what every device
   * was last known to be before the first event arrives. Off the event path by
   * construction — it is called once, from `start()`.
   */
  all(): readonly NcDeviceIdentity[] {
    return [...this.devices.values()]
  }

  /** Has a refresh ever succeeded? A cold directory notifies about nothing. */
  isWarm(): boolean {
    return this.loadedOnce
  }

  /** How many refreshes have answered — see {@link NcDirectoryRefreshOutcome}. */
  answeredGeneration(): number {
    return this.answered
  }

  /**
   * Was this id missing from BOTH of the last two answered refreshes?
   *
   * The deleted-device reconcile's first read. False while fewer than two
   * refreshes have answered: one answer is not two, and a migration swap parks
   * a source id on a temp id for a moment. Failed and empty refreshes neither
   * count nor reset — they are simply not evidence.
   */
  absentFromLastTwoAnswers(deviceId: number): boolean {
    if (this.previousAnswer === null || this.latestAnswer === null) return false
    return !this.previousAnswer.has(deviceId) && !this.latestAnswer.has(deviceId)
  }

  /**
   * Re-read the whole directory. Never throws — a failing device-manager must
   * not take the notification centre's reload tick with it. Says what the read
   * was worth as evidence ({@link NcDirectoryRefreshOutcome}).
   */
  async refresh(): Promise<NcDirectoryRefreshOutcome> {
    try {
      const devices = await this.deps.listDevices()
      const next = new Map<number, NcDeviceIdentity>()
      for (const device of devices) next.set(device.deviceId, device)
      this.devices = next
      if (next.size > 0) {
        this.answered += 1
        this.previousAnswer = this.latestAnswer
        this.latestAnswer = new Set(next.keys())
      }
      const first = !this.loadedOnce
      this.loadedOnce = true
      if (first) {
        this.deps.logger.info('device directory warm', {
          meta: {
            devices: next.size,
            cameras: [...next.values()].filter((d) => isCameraIdentity(d)).length,
          },
        })
      }
      return next.size > 0 ? 'answered' : 'empty'
    } catch (err) {
      // Keep the previous snapshot — see the module docblock. WARN, not debug:
      // while this fails, a NEW camera cannot produce an offline notification
      // at all, and that is invisible from the outside.
      this.deps.logger.warn('device directory refresh failed — keeping the previous snapshot', {
        meta: { devices: this.devices.size, warm: this.loadedOnce, error: String(err) },
      })
      return 'failed'
    }
  }
}
