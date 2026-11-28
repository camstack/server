/**
 * Wyze's side of the core state refresh (D1062): HOW to read, never WHEN.
 *
 * A camera whose motion source is `cloud` learns about motion by reading the
 * Wyze events API (there is no push). The core owns that cadence: it reads at
 * {@link WYZE_CLOUD_MOTION_REFRESH_MS}, and the read folds new events into the
 * camera's raw motion event. Cameras on another motion source register nothing.
 */
import {
  deviceStateRefreshCapability,
  type DeviceContext,
  type InferNativeProvider,
  type StateRefreshPolicy,
} from '@dominevo/types'

/** The cloud events API is read this often per camera. */
export const WYZE_CLOUD_MOTION_REFRESH_MS = 15_000

/** The part of a device context the refresh registration uses. */
export type WyzeRefreshContext = Pick<DeviceContext, 'registerNativeCap'>

export interface WyzeStateRefreshTarget {
  readonly ctx: WyzeRefreshContext
  /** The integration the camera belongs to; empty for a camera added by hand. */
  readonly integrationId: string
  /** The camera's MAC, the fallback group of a camera with no integration. */
  readonly mac: string
  /** Read the cloud events once and emit the new motion; throws when it cannot. */
  readonly readMotion: () => Promise<void>
}

export function wyzeRefreshPolicy(integrationId: string, mac: string): StateRefreshPolicy {
  return {
    integrationId: integrationId !== '' ? integrationId : `wyze-${mac}`,
    minIntervalMs: WYZE_CLOUD_MOTION_REFRESH_MS,
    batch: false,
    push: 'none',
  }
}

export function registerWyzeStateRefresh(target: WyzeStateRefreshTarget): void {
  const provider: InferNativeProvider<typeof deviceStateRefreshCapability> = {
    refresh: async () => {
      await target.readMotion()
      return { ok: true }
    },
    resubscribe: async () => ({ ok: true }),
  }
  target.ctx.registerNativeCap(deviceStateRefreshCapability, provider, {
    stateRefresh: wyzeRefreshPolicy(target.integrationId, target.mac),
  })
}
