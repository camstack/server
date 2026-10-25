import {
  BaseDevice,
  type CamStreamDescriptor,
  type DeviceContext,
  DeviceFeature,
  type InferNativeProvider,
  snapshotCapability,
  streamCatalogCapability,
} from '@camstack/types'
import { z } from 'zod'
import type { TerminalCameraRelay } from './terminal-camera-relay.js'
import {
  TERMINAL_CAMERA_FPS,
  TERMINAL_CAMERA_HEIGHT,
  TERMINAL_CAMERA_WIDTH,
} from './terminal-frame-renderer.js'

const terminalCameraSchema = z.object({
  // Old auto-generated cameras have no instance. They remain readable during
  // the explicit-instance migration but are never re-declared automatically.
  instanceId: z.string().min(1).optional(),
  nodeId: z.string().min(1),
  // v1 declared one monitor camera per node and persisted only `nodeId`.
  // Defaults let that stable legacy device boot so reconciliation can persist
  // the complete profile config without deleting and recreating it.
  profileId: z.string().min(1).default('monitor'),
  profileLabel: z.string().min(1).default('BTM'),
})

let relay: TerminalCameraRelay | null = null

export function installTerminalCameraRelay(next: TerminalCameraRelay | null): void {
  relay = next
}

export class TerminalCameraDevice extends BaseDevice<typeof terminalCameraSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.NativeSnapshot]

  constructor(ctx: DeviceContext) {
    super(ctx, terminalCameraSchema, { type: ctx.deviceMeta.type })
    const provider: InferNativeProvider<typeof streamCatalogCapability> = {
      getCatalog: async ({ deviceId }) => {
        if (deviceId !== this.id) return []
        return this.catalog()
      },
    }
    this.ctx.registerNativeCap(streamCatalogCapability, provider)
    const snapshotProvider: InferNativeProvider<typeof snapshotCapability> = {
      getSnapshot: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `TerminalCameraDevice: deviceId mismatch, expected ${String(this.id)}, got ${String(deviceId)}`,
          )
        }
        const activeRelay = relay
        if (!activeRelay) throw new Error('terminal camera relay is unavailable')
        const jpeg = await activeRelay.snapshot(
          this.relayInstanceId(),
          this.config.get('nodeId'),
          this.config.get('profileId'),
        )
        return { base64: jpeg.toString('base64'), contentType: 'image/jpeg' }
      },
      invalidateCache: async () => {
        // The snapshot wrapper owns its own cache. The relay deliberately
        // renders every snapshot request afresh.
      },
    }
    this.ctx.registerNativeCap(snapshotCapability, snapshotProvider)
    this.markOnline(true)
  }

  private async catalog(): Promise<readonly CamStreamDescriptor[]> {
    const activeRelay = relay
    if (!activeRelay) throw new Error('terminal camera relay is unavailable')
    const nodeId = this.config.get('nodeId')
    const profileId = this.config.get('profileId')
    const instanceId = this.relayInstanceId()
    return [
      {
        camStreamId: profileId,
        kind: 'pull-http' as const,
        url: activeRelay.streamUrl(instanceId, nodeId, profileId),
        codec: 'h264',
        resolution: { width: TERMINAL_CAMERA_WIDTH, height: TERMINAL_CAMERA_HEIGHT },
        fps: TERMINAL_CAMERA_FPS,
        label: this.config.get('profileLabel'),
      },
    ]
  }

  setNodeOnline(online: boolean): void {
    this.markOnline(online)
    if (!online) {
      void relay?.closeInstance(this.relayInstanceId())
    }
  }

  override async removeDevice(): Promise<void> {
    await relay?.closeInstance(this.relayInstanceId())
  }

  private relayInstanceId(): string {
    return this.config.get('instanceId') ?? `legacy:${this.stableId}`
  }
}
