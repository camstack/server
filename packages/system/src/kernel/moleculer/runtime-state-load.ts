/**
 * The runtime-state load a worker hydrates a device from (D677).
 *
 * `deviceManager.loadRuntimeState` answers the device's stored slices. A load
 * that FAILED is not an empty row: hydrating a provider from `{}` builds the
 * device on cold-start defaults (Reolink's onboard AI "no restored state —
 * OFF"), and the provider's first writes then carry those defaults over the
 * restored values. So a build whose load did not answer is REFUSED, by name,
 * with `tags.deviceId` — never quietly started empty (D49, D391).
 */
import type { IScopedLogger } from '@camstack/types'

/** Where the load was for — named on the refusal line. */
export type RuntimeStateLoadPhase = 'create' | 'accessory-child' | 'rebuild' | 'context'

/** A device build refused because its runtime state could not be loaded. */
export class RuntimeStateLoadError extends Error {
  constructor(
    readonly deviceId: number,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(
      `runtime state of device ${deviceId} could not be loaded (${reason}) — ` +
        'the device is not built from an empty state',
      options,
    )
    this.name = 'RuntimeStateLoadError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface RuntimeStateLoadTarget {
  readonly deviceId: number
  readonly stableId: string
  readonly phase: RuntimeStateLoadPhase
}

/**
 * Load the device's runtime state, or throw {@link RuntimeStateLoadError}
 * after one warn naming the device. An answer that is not an object is a
 * failed load too — it would hydrate as nothing.
 */
export async function loadRuntimeStateOrRefuse(
  load: () => Promise<unknown>,
  logger: IScopedLogger,
  target: RuntimeStateLoadTarget,
): Promise<Record<string, unknown>> {
  const refuse = (reason: string, cause?: unknown): never => {
    logger.warn(
      'loadRuntimeState failed — device build refused, never hydrated from an empty state (D677)',
      {
        tags: { deviceId: target.deviceId, stableId: target.stableId },
        meta: { phase: target.phase, error: reason },
      },
    )
    throw new RuntimeStateLoadError(
      target.deviceId,
      reason,
      cause === undefined ? undefined : { cause },
    )
  }
  let answer: unknown
  try {
    answer = await load()
  } catch (err: unknown) {
    return refuse(errorMessage(err), err)
  }
  if (!isRecord(answer)) return refuse(`answered ${answer === null ? 'null' : typeof answer}`)
  return answer
}
