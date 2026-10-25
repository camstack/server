/**
 * Switch off every analyzer a Terminal camera would otherwise pay for, by
 * writing the AUTHORITY that owns each one
 * ([D113](../../../docs/decisions/adr-0113.md)).
 *
 * ## Why a Terminal camera must cost nothing
 *
 * A Terminal camera is a rendered screen. Object detection on it finds nothing,
 * forever, at full cost. Measured on the hub 2026-08-11, for ONE terminal
 * camera: 19 frames per 10 s through the detection pipeline at ~61 ms of
 * inference each, plus 115 capture-scheduler requests a minute — against
 * `detections=0`. Multiply by one terminal per node and it is a standing tax on
 * a hub that was already shedding 86 % of its capture queue.
 *
 * **`motion-detection` is switched off too**, and it is the one that matters
 * most now that the detection gate (D109) stops the detection producer: the
 * motion analyzer is the remaining thing that asks for decoded frames, so
 * leaving it bound keeps a decode session alive for a screen recording of a
 * terminal. Zero load means zero decode demand, not "inference-free frames".
 *
 * ## Why this writes `setWrapperActive` and not a switch cap
 *
 * It used to route through `pipelineOrchestrator.setCameraSwitch`. That cap is
 * a deprecated compatibility surface being withdrawn, so the call is made to the
 * authority the switch was only ever writing through — the wrapper binding
 * itself. The wrapper addon id is resolved from `getBindings`, never guessed:
 * `setWrapperActive` needs the addon actually providing the cap, and a hardcoded
 * id is a silent no-op the day a second provider ships.
 *
 * ## It FAILS LOUDLY
 *
 * The previous implementation caught everything and warned. A warn that nobody
 * reads is how the full-detection-cost tax gets re-created: the camera keeps
 * working, so nothing looks broken, and the only symptom is a hub that runs hot
 * for reasons nobody connects to a terminal created three weeks ago. A
 * resolution that fails now THROWS, because "we could not turn this off" is a
 * fact the caller must act on, not a line in a log.
 */
import type { AddonApi, IScopedLogger } from '@camstack/types'
import { DERIVED_CAMERA_SILENCED_CAP_NAMES, errMsg } from '@camstack/types'

/**
 * Every analyser a Terminal camera is created with switched OFF.
 *
 * An alias, not a copy. This list and the grid's were separate and had drifted
 * — neither named `pipeline-analytics` — so both now read the one in
 * `@camstack/types`, which is the package they already share.
 */
export const TERMINAL_SILENCED_CAP_NAMES = DERIVED_CAMERA_SILENCED_CAP_NAMES

export interface SilenceAnalysisDeps {
  readonly api: AddonApi
  readonly logger: IScopedLogger
}

/**
 * Resolve the addon currently providing `capName` for this device.
 *
 * Inlined rather than reached for through a helper because there is exactly one
 * honest source: the device's own bindings. `listBindableCapsForDeviceType`
 * answers for the device TYPE and would happily name a wrapper that is not the
 * one bound here.
 *
 * Returns `null` when the cap is not bound at all — which is not an error: a
 * deployment with no audio analyzer has nothing to switch off, and demanding one
 * would make every terminal creation fail on a perfectly valid hub.
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
    // A bound wrapper with an empty provider id is a broken binding, not an
    // absent one — writing it would be a no-op nobody would ever notice.
    if (entry.providerAddonId === '') return null
    return entry.providerAddonId
  }
  return null
}

/**
 * Switch every analyzer in {@link TERMINAL_SILENCED_CAP_NAMES} off for one
 * Terminal camera.
 *
 * Called ONLY on creation. An operator who deliberately turns detection back on
 * for a terminal must win, and a reconcile that re-asserted every pass would
 * silently overrule them once a minute.
 *
 * @throws if a cap IS bound and the write to its authority failed. The camera
 * would then be running a full analyzer for a screen recording, which is the
 * exact cost this exists to remove — and a silent version of that failure is
 * unfindable.
 */
export async function silenceAnalysisFor(
  deps: SilenceAnalysisDeps,
  deviceId: number,
): Promise<void> {
  const failures: string[] = []
  for (const capName of TERMINAL_SILENCED_CAP_NAMES) {
    try {
      const wrapperAddonId = await resolveBoundWrapper(deps.api, deviceId, capName)
      if (wrapperAddonId === null) {
        // Nothing bound, nothing to pay for, nothing to switch. Logged because
        // a branch that drops work silently reads as "it never happened", and
        // this is the branch that would hide a rename of a cap name.
        deps.logger.debug('terminal camera: no analyzer bound for this capability', {
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
      deps.logger.info('terminal camera: analyzer switched off at its authority', {
        tags: { deviceId },
        meta: { capName, wrapperAddonId },
      })
    } catch (err) {
      failures.push(`${capName}: ${errMsg(err)}`)
      deps.logger.error('terminal camera: could NOT switch an analyzer off', {
        tags: { deviceId },
        meta: { capName, error: errMsg(err) },
      })
    }
  }
  if (failures.length > 0)
    throw new Error(
      `terminal camera ${deviceId}: could not switch off ${failures.length} analyzer(s) — it will run at full detection cost (${failures.join('; ')})`,
    )
}
