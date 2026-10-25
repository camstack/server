/**
 * The dead-device eviction lane's GATE — "may I believe this camera is gone?"
 *
 * Under disk pressure the recorder evicts footage belonging to devices the
 * registry no longer knows BEFORE anything chosen by age. That decision is
 * driven by a fallible read of somebody else's store, and its failure mode is a
 * DELETE of a live camera's footage — the one output in this system that cannot
 * be re-run. So the gate is built the way D49/D72 say a work-destroying gate is
 * built, and every rule below is one of theirs:
 *
 * 1. **Only an ANSWERED read arms anything.** A throw, a timeout, an absent
 *    `ctx.api` — none of them mean "the camera was deleted". They mean nothing
 *    at all, and the caller falls back to plain oldest-first, which is today's
 *    behaviour and is always safe.
 * 2. **An EMPTY enumeration is not an answer.** A store answering from an empty
 *    snapshot (D44) and a hub whose every camera was deleted produce the same
 *    array. The `stream-broker` profile-map prune refuses on this for the same
 *    reason; here the stake is footage rather than a slot map.
 * 3. **A read that knows NONE of the cameras holding footage is a defect
 *    report, not a fleet-wide deletion.** This is D72's lesson: corroboration
 *    defends against a TRANSIENT wrong read and not at all against a
 *    SYSTEMATIC one — two systematically wrong reads agree with each other. If
 *    the id space ever drifts (the doorbell's `addon:` prefix, in device-id
 *    form), every camera looks dead at once, and that is the one shape
 *    repetition can never catch. It is refused, loudly.
 * 4. **An absence is believed only when CONFIRMED TWICE, by reads taken apart
 *    in time.** {@link ORPHAN_REGISTRY_MIN_GAP_MS} is what makes the second
 *    read independent: without it the eight rounds of a single pressure sweep
 *    would "confirm" each other inside one transient window, which is not
 *    corroboration, it is the same read counted twice.
 * 5. **A device seen PRESENT is believed immediately** and its streak is
 *    dropped. Positive evidence restores work; only the negative needs a
 *    second opinion. This is also why `unbound` is not terminal in D72 — a
 *    latch with no recovery path is worse than the bug it was defending
 *    against.
 *
 * ## Where the memory lives, and what a restart does to it
 *
 * In RAM, in this object, for the life of the recorder runner — and
 * DELIBERATELY not on disk. A persisted "I saw this camera absent once" is a
 * latch: it survives the process that made the observation, cannot be graded
 * later, and turns a single bad read into a permanent authorisation to delete.
 * That is exactly the failure D72 was written for.
 *
 * So a restart costs one registry read: the first answered read after boot
 * re-arms every absence, the second (≥{@link ORPHAN_REGISTRY_MIN_GAP_MS}
 * later, i.e. the next pressure sweep) confirms it. In between, eviction is
 * plain oldest-first. Deferring relief by one sweep is free; deleting a live
 * camera's footage is not.
 */
import type { IScopedLogger } from '@camstack/types'

/**
 * What a device-registry enumeration came back as.
 *
 * A discriminated union rather than `Set | null` because the two failures are
 * not the same fact and only one of them is worth a warn: `unanswered` is a
 * read that never landed, and it is the safe, expected state whenever the hub
 * is unreachable.
 */
export type DeviceRegistryRead =
  | { readonly status: 'answered'; readonly deviceIds: ReadonlySet<number> }
  | { readonly status: 'unanswered'; readonly detail: string }

/**
 * Independent answered reads that must agree a device is gone before its
 * footage may be chosen ahead of age.
 */
export const ORPHAN_CONFIRMATIONS_REQUIRED = 2

/**
 * Minimum wall-clock gap between two reads that may corroborate each other.
 *
 * A pressure sweep runs up to eight relief rounds back-to-back. Eight reads
 * inside a second are one read as far as a transient store fault is concerned,
 * so a fresh read is only TAKEN once per gap; the rounds in between reuse the
 * verdict already reached. 30 s sits under the 60 s sweep period, which makes
 * "one confirming read per sweep" the actual cadence.
 */
export const ORPHAN_REGISTRY_MIN_GAP_MS = 30_000

export interface OrphanDeviceLaneDeps {
  /**
   * Enumerate the devices the registry currently knows. MUST report an
   * unanswered read as `unanswered` rather than as an empty set — the whole
   * gate rests on that distinction.
   */
  readonly readRegistry: () => Promise<DeviceRegistryRead>
  readonly logger: IScopedLogger
  /** Injected by tests. Production takes `Date.now`. */
  readonly now?: () => number
  /** Overrides {@link ORPHAN_REGISTRY_MIN_GAP_MS}; exists so a test can make
   *  the two corroborating reads reachable without waiting 30 s. */
  readonly minGapMs?: number
}

export class OrphanDeviceLane {
  /** deviceId → consecutive ANSWERED reads that did not contain it. */
  private readonly absenceStreak = new Map<number, number>()
  /** The verdict the last answered read reached, reused inside the gap. */
  private confirmed: ReadonlySet<number> = new Set<number>()
  /** When a read was last TAKEN (answered or not) — the gap is a rate limit on
   *  asking, not on believing. */
  private lastReadAtMs: number | null = null

  constructor(private readonly deps: OrphanDeviceLaneDeps) {}

  /**
   * Of the devices that hold footage here, which ones has the registry
   * confirmed — twice, on reads taken apart in time — that it no longer knows?
   *
   * Never throws: every failure returns the empty set, which is "evict the way
   * this repo evicted before the lane existed".
   */
  async confirmedOrphans(footageDevices: ReadonlySet<number>): Promise<ReadonlySet<number>> {
    if (footageDevices.size === 0) return new Set<number>()
    const now = this.deps.now?.() ?? Date.now()
    const minGap = this.deps.minGapMs ?? ORPHAN_REGISTRY_MIN_GAP_MS
    if (this.lastReadAtMs !== null && now - this.lastReadAtMs < minGap) {
      return intersect(this.confirmed, footageDevices)
    }

    const read = await this.readOnce()
    this.lastReadAtMs = now
    const known = this.trustedDeviceIds(read, footageDevices)
    if (known === null) {
      // Rules 1-3, verbatim: a read that carries no information changes nothing
      // — it neither arms a new absence nor disarms one already corroborated.
      // From a cold start `confirmed` is empty, so this evicts exactly as the
      // provider did before the lane existed.
      return intersect(this.confirmed, footageDevices)
    }

    this.advanceStreaks(known, footageDevices)
    const confirmed = new Set<number>()
    for (const [deviceId, streak] of this.absenceStreak) {
      if (streak >= ORPHAN_CONFIRMATIONS_REQUIRED) confirmed.add(deviceId)
    }
    this.confirmed = confirmed
    return intersect(confirmed, footageDevices)
  }

  /** The read, with a throw folded into the union rather than escaping. */
  private async readOnce(): Promise<DeviceRegistryRead> {
    try {
      return await this.deps.readRegistry()
    } catch (err) {
      return { status: 'unanswered', detail: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Rules 1-3: the device ids this read may be believed about, or `null` when
   * it may not be believed at all.
   *
   * Every refusal is SAID — a lane that silently declines to run is
   * indistinguishable from one nobody wired, and this branch drops work (the
   * operator's ordering) on purpose.
   */
  private trustedDeviceIds(
    read: DeviceRegistryRead,
    footageDevices: ReadonlySet<number>,
  ): ReadonlySet<number> | null {
    if (read.status === 'unanswered') {
      this.deps.logger.warn(
        'recorder: dead-device eviction lane disarmed — the device registry did not answer; evicting oldest-first only',
        { meta: { detail: read.detail, footageDevices: footageDevices.size } },
      )
      return null
    }
    if (read.deviceIds.size === 0) {
      this.deps.logger.warn(
        'recorder: dead-device eviction lane disarmed — the device enumeration came back empty, which an empty store snapshot also looks like',
        { meta: { footageDevices: footageDevices.size } },
      )
      return null
    }
    let recognised = 0
    for (const deviceId of footageDevices) if (read.deviceIds.has(deviceId)) recognised += 1
    if (recognised === 0) {
      this.deps.logger.warn(
        'recorder: dead-device eviction lane disarmed — the registry knows NONE of the cameras holding footage here, which is a defect report and not a fleet-wide deletion',
        { meta: { footageDevices: footageDevices.size, registryDevices: read.deviceIds.size } },
      )
      return null
    }
    return read.deviceIds
  }

  /** Rules 4 and 5, plus the bound: the map only ever holds devices that hold
   *  footage right now, so it cannot outgrow the archive. */
  private advanceStreaks(known: ReadonlySet<number>, footageDevices: ReadonlySet<number>): void {
    for (const deviceId of this.absenceStreak.keys()) {
      if (!footageDevices.has(deviceId)) this.absenceStreak.delete(deviceId)
    }
    for (const deviceId of footageDevices) {
      if (known.has(deviceId)) {
        this.absenceStreak.delete(deviceId)
        continue
      }
      const streak = (this.absenceStreak.get(deviceId) ?? 0) + 1
      this.absenceStreak.set(deviceId, streak)
      if (streak === ORPHAN_CONFIRMATIONS_REQUIRED) {
        this.deps.logger.warn(
          'recorder: camera confirmed gone by two independent registry reads — its footage is now evicted before anything chosen by age',
          { tags: { deviceId }, meta: { confirmations: streak } },
        )
      }
    }
  }
}

function intersect(a: ReadonlySet<number>, b: ReadonlySet<number>): ReadonlySet<number> {
  const out = new Set<number>()
  for (const value of a) if (b.has(value)) out.add(value)
  return out
}
