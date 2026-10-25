/**
 * A camera's `motion` slice, read from the HUB (D696).
 *
 * The orchestrator is the only writer of a camera's `motion` runtime slice, and
 * it writes the EFFECTIVE value on the hub. A camera provider's local runtime
 * state therefore holds no `motion` slice, and BOTH of its `motion` reads —
 * `isDetected` and `getStatus` — answer from here. Build the provider with
 * {@link hubMotionNativeProvider}: a provider that serves only `isDetected`
 * gets the framework's default `getStatus`, which reads the provider's LOCAL
 * runtime state, and that answered `null` for every camera on the fleet while
 * the hub's slice was written (the viewer's Motion order ranked one composite
 * grid above every camera, 2026-10-06).
 *
 * The two reads say "unknown" in the shape their contract allows:
 * - the read did not answer (the hub is unreachable, the call threw): both
 *   fail, neither answers "no motion" (D49, D393);
 * - nobody has published the camera's motion since the hub started (the slice
 *   is session-durable): `getStatus` answers `null` — the status contract's
 *   own "no status" — and `isDetected`, a bare boolean with no room for it,
 *   fails;
 * - a slice that is not a `MotionStatus`: both fail, naming the device.
 */
import { type InferNativeProvider } from '../capabilities/capability-definition.js'
import {
  type MotionStatus,
  MotionStatusSchema,
  type motionCapability,
} from '../capabilities/motion.cap.js'

/** The one `deviceState` read this needs. `ctx.api.deviceState` satisfies it. */
export interface HubMotionSliceReader {
  readonly getCapSlice: {
    readonly query: (input: {
      deviceId: number
      capName: string
    }) => Promise<Readonly<Record<string, unknown>> | null>
  }
}

async function readSlice(
  deviceState: HubMotionSliceReader,
  deviceId: number,
): Promise<Readonly<Record<string, unknown>> | null> {
  try {
    return await deviceState.getCapSlice.query({ deviceId, capName: 'motion' })
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`motion state of device ${deviceId} is unreadable: ${reason}`, { cause: err })
  }
}

/**
 * The hub's `motion` slice as a `MotionStatus`, or `null` when nobody has
 * published it since the hub started. Throws when the hub does not answer or
 * the slice is malformed — never a made-up "no motion".
 */
export async function readHubMotionStatus(
  deviceState: HubMotionSliceReader,
  deviceId: number,
): Promise<MotionStatus | null> {
  const slice = await readSlice(deviceState, deviceId)
  if (slice === null) return null
  const parsed = MotionStatusSchema.safeParse(slice)
  if (!parsed.success) {
    throw new Error(
      `motion state of device ${deviceId} is malformed on the hub: ${parsed.error.message}`,
    )
  }
  return parsed.data
}

export async function readHubMotionDetected(
  deviceState: HubMotionSliceReader,
  deviceId: number,
): Promise<boolean> {
  const slice = await readSlice(deviceState, deviceId)
  const detected = slice?.['detected']
  if (typeof detected !== 'boolean') {
    throw new Error(`motion state of device ${deviceId} is not published yet (unknown)`)
  }
  return detected
}

/**
 * The native `motion` provider of a camera whose slice the orchestrator writes
 * (D696): `isDetected` AND `getStatus`, both from the hub. `owner` names the
 * provider class in the deviceId-mismatch error.
 */
export function hubMotionNativeProvider(
  deviceState: HubMotionSliceReader,
  deviceId: number,
  owner: string,
): InferNativeProvider<typeof motionCapability> {
  const ownDevice = (asked: number): void => {
    if (asked !== deviceId) {
      throw new Error(`${owner}: motion deviceId mismatch, expected ${deviceId}, got ${asked}`)
    }
  }
  return {
    isDetected: async ({ deviceId: asked }) => {
      ownDevice(asked)
      return readHubMotionDetected(deviceState, deviceId)
    },
    getStatus: async ({ deviceId: asked }) => {
      ownDevice(asked)
      return readHubMotionStatus(deviceState, deviceId)
    },
  }
}
