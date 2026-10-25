/**
 * Where a camera's first-level detections come from — the read model and the
 * vendor-flag half of the write.
 *
 * The authority is the camera's stored `detectionSources` (the orchestrator's
 * per-device store, beside `motionSources`); this file only translates between
 * that list and the three picks an operator has (D507: a camera runs AT MOST
 * ONE root detector, so there is no "both"):
 *
 *   `['pipeline']` → `pipeline`   this node's own root step on decoded frames
 *   `['onboard']`  → `onboard`    the camera's own detector, alone
 *   `[]`           → `none`       no root detector, deliberately
 *
 * The vendor's boxed-sub-stream flag is the MECHANISM the pick drives, never a
 * second switch (D62): {@link armOnboardChannel} is its only writer here.
 */
import type { AddonContext, CameraDetectionSource, IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'

export type OnboardGeometry = 'boxed' | 'while-streaming' | 'flag-only' | 'unknown'

export interface CameraDetectionSourceView {
  readonly source: CameraDetectionSource
  /** False while the operator has never picked and the default stands. */
  readonly explicit: boolean
  readonly onboard: { readonly available: boolean; readonly geometry: OnboardGeometry }
}

/**
 * The pick a stored list means. A legacy two-root list is truncated to its
 * first element — the same rule the schema applies on the attach path
 * (`DetectionSourcesSchema`), so the UI shows what actually runs. Absent or
 * unreadable is the default, `pipeline`: a value that cannot be read is not an
 * empty pick.
 */
export function pickFromStored(raw: unknown): {
  readonly source: CameraDetectionSource
  readonly explicit: boolean
} {
  if (!Array.isArray(raw)) return { source: 'pipeline', explicit: false }
  const first = raw.find((v): v is string => typeof v === 'string')
  if (first === undefined) return { source: 'none', explicit: true }
  return { source: first === 'onboard' ? 'onboard' : 'pipeline', explicit: true }
}

/** The list a pick is stored as. */
export function storedFromPick(source: CameraDetectionSource): readonly string[] {
  return source === 'none' ? [] : [source]
}

export interface DetectionSourceReadDeps {
  readonly ctx: () => AddonContext
  readonly deviceHasNativeObjectDetectionCap: (deviceId: number) => Promise<boolean>
}

/**
 * What the camera's detections actually CARRY, asked of the cap that knows. A
 * camera whose firmware ships no bounding box cannot be a root step — there is
 * nothing to track — and the operator has to read that BEFORE picking.
 * `unknown` stays unknown: a cap that could not answer is not "flag-only".
 */
async function readGeometry(
  deps: DetectionSourceReadDeps,
  deviceId: number,
): Promise<OnboardGeometry> {
  try {
    const options = await deps.ctx().api?.nativeObjectDetection.getOptions.query({ deviceId })
    if (
      options?.geometry === 'boxed' ||
      options?.geometry === 'while-streaming' ||
      options?.geometry === 'flag-only'
    ) {
      return options.geometry
    }
  } catch {
    // Unknown stays unknown.
  }
  return 'unknown'
}

export async function readCameraDetectionSource(
  deps: DetectionSourceReadDeps,
  deviceId: number,
): Promise<CameraDetectionSourceView> {
  let raw: unknown
  try {
    const stored = await deps.ctx().settings?.readDeviceStore(deviceId)
    raw = (stored as Record<string, unknown> | undefined)?.['detectionSources']
  } catch {
    // Unreadable settings are not an empty pick: the default stands.
  }
  const { source, explicit } = pickFromStored(raw)
  const available = await deps.deviceHasNativeObjectDetectionCap(deviceId)
  return {
    source,
    explicit,
    onboard: {
      available,
      geometry: available ? await readGeometry(deps, deviceId) : 'unknown',
    },
  }
}

/**
 * Arm (or disarm) the vendor's boxed sub-stream for a camera whose root
 * detector is its own firmware — and stop paying for it on a camera that just
 * stopped being one. A failure is logged and swallowed: the setting still
 * lands, and the sub-stream re-arms on the provider's next login or the
 * orchestrator's forwarding reconcile.
 */
export async function armOnboardChannel(
  ctx: () => AddonContext,
  deviceId: number,
  wantsOnboard: boolean,
): Promise<void> {
  try {
    await ctx().api?.nativeObjectDetection.setEnabled.mutate({ deviceId, enabled: wantsOnboard })
  } catch (err: unknown) {
    const logger: IScopedLogger = ctx().logger
    logger.warn('failed to arm the onboard detection channel', {
      tags: { deviceId },
      meta: { wantsOnboard, error: errMsg(err) },
    })
  }
}
