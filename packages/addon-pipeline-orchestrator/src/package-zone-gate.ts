/**
 * The orchestrator's in-memory mirror of ONE durable fact per camera: does it
 * have a package zone, and therefore does `package-detection` belong in its
 * resolved pipeline?
 *
 * WHY A MIRROR AND NOT A READ. `package-detection` has no operator toggle by
 * design — drawing an enabled `package`-stage zone rule IS the enable, deleting
 * every one of them IS the disable ({@link applyPackageZoneActivation}). So the
 * resolver appends the step when the answer is yes and STRIPS it when the
 * answer is no, and the answer came from `zoneRules.listRules`, which folds any
 * read error into `[]`. An unanswerable store therefore looked exactly like
 * "the operator deleted the zone": the step vanished from the resolved tree,
 * the runner stopped dispatching it, and not one line was written. That is the
 * doorbell shape — a decision that DESTROYS work gated on a fallible read
 * ([D49](../../../docs/decisions/adr-0049.md); the virtual doorbell's binding
 * mirror, retired with it in D671).
 *
 * TWO DEFENCES, FOR TWO DIFFERENT FAILURES. The doorbell could not grade its
 * read at all: a genuine unbind and a store answering from an empty snapshot
 * produced identical responses, so corroboration was the only discriminator.
 * Here a THROWN read is distinguishable (that is what
 * {@link ZoneRulesRead} exists for), so both defences apply and they cover
 * different things:
 *
 *  - a read that FAILED carries no information → the mirror is untouched and
 *    the last-known-good answer stands. Logged at `warn`, never `debug`.
 *  - a read that SUCCEEDED but is empty for a camera the mirror had as zoned is
 *    the D44 shape (`readDeviceStore` answering `{}` WITHOUT throwing — it
 *    emptied every addon store once already, and every device disappeared) →
 *    it ARMS the strip and needs a second consecutive agreeing read to apply.
 *
 * ERRING. Only the destructive transition (zoned → unzoned) is corroborated. A
 * camera that has never been read successfully stays OFF: packages are opt-in
 * per camera, so erring open there would put a parcel detector on every camera
 * in the fleet. The cost of the chosen erring is that a genuinely deleted
 * package zone keeps its detector for one extra resolve; the cost of the
 * alternative is the silent strip this class exists to prevent.
 */
import type { IScopedLogger, ZoneRule } from '@camstack/types'

import type { ZoneRulesRead } from './zone-rules-provider.js'

/**
 * `zoned` — a read saw an enabled package zone.
 * `strip-pending` — one read did not; NOT yet believed, the step stays.
 * `unzoned` — believed: either two consecutive reads agree, or the camera's
 *   FIRST successful read already said no (nothing to destroy).
 */
export type PackageZoneState = 'zoned' | 'strip-pending' | 'unzoned'

/**
 * Fold one SUCCESSFUL read into the mirror. A read that failed must never reach
 * this function — an unanswerable store carries no information and must leave
 * the mirror exactly as it was.
 */
export function nextPackageZoneState(
  previous: PackageZoneState | undefined,
  zonedNow: boolean,
): PackageZoneState {
  if (zonedNow) return 'zoned'
  // Only a camera the mirror BELIEVED was zoned has work to destroy; that is
  // the transition that needs a second opinion.
  return previous === 'zoned' ? 'strip-pending' : 'unzoned'
}

/** Does this state put `package-detection` in the resolved tree? */
export function activatesPackageDetection(state: PackageZoneState | undefined): boolean {
  return state === 'zoned' || state === 'strip-pending'
}

/**
 * A "package zone" is an ENABLED `package`-stage zone rule that references at
 * least one polygon. A rule with no zones targets nothing; a disabled one is
 * the operator's own off switch.
 */
export function hasEnabledPackageZone(rules: readonly ZoneRule[]): boolean {
  return rules.some((r) => r.enabled !== false && r.zoneIds.length > 0)
}

export interface PackageZoneGateDeps {
  /** The CHECKED read — `ZoneRulesProvider.listRulesChecked` in production. */
  readonly readPackageRules: (deviceId: number) => Promise<ZoneRulesRead>
  readonly logger: IScopedLogger
}

/**
 * Per-device mirror + the logging every branch of it owes. Constructed once by
 * the orchestrator bootstrap and consulted by the settings store's
 * `hasPackageZone` dependency on every `resolvePipelineForDevice`.
 */
export class PackageZoneGate {
  private readonly mirror = new Map<number, PackageZoneState>()

  constructor(private readonly deps: PackageZoneGateDeps) {}

  /** Drop a device's mirror entry — called when the device is removed. */
  forgetDevice(deviceId: number): void {
    this.mirror.delete(deviceId)
  }

  /** Test/diagnostic view of the mirror. Never used to make a decision. */
  peek(deviceId: number): PackageZoneState | undefined {
    return this.mirror.get(deviceId)
  }

  async isActive(deviceId: number): Promise<boolean> {
    const previous = this.mirror.get(deviceId)
    const read = await this.deps.readPackageRules(deviceId)

    if (!read.ok) {
      const keeping = activatesPackageDetection(previous)
      this.deps.logger.warn(
        'package-zone read FAILED — keeping the last-known-good answer rather than stripping package-detection',
        {
          tags: { deviceId },
          meta: {
            error: read.error,
            lastKnown: previous ?? 'never-read',
            packageDetectionActive: keeping,
          },
        },
      )
      return keeping
    }

    const zonedNow = hasEnabledPackageZone(read.rules)
    const next = nextPackageZoneState(previous, zonedNow)
    this.mirror.set(deviceId, next)

    if (next === 'strip-pending') {
      this.deps.logger.warn(
        'package zones read as ABSENT for a camera that had them — NOT stripping yet, a second agreeing read is required',
        { tags: { deviceId }, meta: { ruleCount: read.rules.length } },
      )
    } else if (next === 'unzoned' && previous === 'strip-pending') {
      this.deps.logger.warn(
        'package-detection STRIPPED — two consecutive reads agree this camera has no enabled package zone',
        { tags: { deviceId }, meta: { ruleCount: read.rules.length } },
      )
    }

    return activatesPackageDetection(next)
  }
}
