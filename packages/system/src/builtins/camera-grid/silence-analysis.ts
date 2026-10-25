/**
 * Every analyzer a composite camera is created with switched OFF.
 *
 * A grid is a picture we composed from cameras that are ALREADY analyzed. Running
 * detection on the composite would pay for the same subjects a second time, and
 * would attribute them to a camera that does not exist as a viewpoint — a person
 * detected in the bottom-right cell is a person on THAT camera, not on the grid.
 *
 * `motion-detection` sits first deliberately: it is the one that holds the decode
 * session open, so its absence is the difference between a grid costing a
 * composition and costing a full decode pipeline. Same ordering, and the same
 * reason, as the Terminal addon's list.
 *
 * Called ONLY on creation. An operator who deliberately turns detection back on
 * for a grid must win, and a reconcile that re-asserted every pass would silently
 * overrule them once a minute.
 */
import {
  DERIVED_CAMERA_SILENCED_CAP_NAMES,
  errMsg,
  type AddonApi,
  type IScopedLogger,
} from '@camstack/types'

/**
 * The list lives in `@camstack/types` now, and this is an alias rather than a
 * second copy. There WERE two — this one and the Terminal addon's — and they
 * had drifted: neither named `pipeline-analytics`, the one cap with no gate of
 * its own, which is what a grid forwarding its sources' motion would have used
 * to write a duplicate motion episode per event.
 */
export const GRID_SILENCED_CAP_NAMES: readonly string[] = DERIVED_CAMERA_SILENCED_CAP_NAMES

export interface SilenceAnalysisDeps {
  readonly api: AddonApi
  readonly logger: IScopedLogger
}

/**
 * Resolve the addon currently providing `capName` for this device, from the
 * device's OWN bindings. `listBindableCapsForDeviceType` answers for the device
 * TYPE and would happily name a wrapper that is not the one bound here.
 *
 * `null` when the cap is not bound at all — not an error: a deployment with no
 * audio analyzer has nothing to switch off, and demanding one would make every
 * grid creation fail on a perfectly valid hub.
 */
async function resolveBoundWrapper(
  api: AddonApi,
  deviceId: number,
  capName: string,
): Promise<string | null> {
  const bindings = await api.deviceManager.getBindings.query({ deviceId })
  for (const entry of bindings.entries) {
    if (entry.capName !== capName) continue
    if (entry.kind !== 'wrapped') continue
    // A bound wrapper with an empty provider id is a BROKEN binding, not an
    // absent one — writing it would be a no-op nobody would ever notice.
    if (entry.providerAddonId === '') return null
    return entry.providerAddonId
  }
  return null
}

/**
 * @throws if a cap IS bound and the write to its authority failed. The composite
 * would then be running a full analyzer over a picture whose subjects are already
 * counted elsewhere — exactly the cost this removes — and a silent version of
 * that failure is unfindable.
 */
export async function silenceAnalysisFor(
  deps: SilenceAnalysisDeps,
  deviceId: number,
): Promise<void> {
  const failures: string[] = []
  for (const capName of GRID_SILENCED_CAP_NAMES) {
    try {
      const wrapperAddonId = await resolveBoundWrapper(deps.api, deviceId, capName)
      if (wrapperAddonId === null) {
        // Logged because a branch that drops work silently reads as "it never
        // happened", and this is the branch that would hide a cap rename.
        deps.logger.debug('camera grid: no analyzer bound for this capability', {
          tags: { deviceId },
          meta: { capName },
        })
        continue
      }
      await deps.api.deviceManager.setWrapperActive.mutate({
        deviceId,
        capName,
        wrapperAddonId,
        active: false,
      })
      deps.logger.info('camera grid: analyzer switched off at its authority', {
        tags: { deviceId },
        meta: { capName, wrapperAddonId },
      })
    } catch (err) {
      failures.push(`${capName}: ${errMsg(err)}`)
      deps.logger.error('camera grid: could NOT switch an analyzer off', {
        tags: { deviceId },
        meta: { capName, error: errMsg(err) },
      })
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `camera grid ${deviceId}: could not switch off ${failures.length} analyzer(s) — ` +
        `it will run at full detection cost (${failures.join('; ')})`,
    )
  }
}
