import {
  BaseDevice,
  type DeviceContext,
  type DeviceFeature,
  DeviceRole,
  DeviceType,
  errMsg,
  type FloodStatus,
  floodCapability,
  type InferNativeProvider,
} from '@camstack/types'
import { veluxRainSensorSchema } from '../config.js'
import type { VeluxNode } from '../velux-client-contract.js'
import { veluxGateways } from '../velux-node-resolver.js'
import { nodeToFloodStatus } from '../velux-protocol.js'

const DRY: FloodStatus = { flooded: false, lastChangedAt: 0 }

/**
 * The rain sensor built into a VELUX roof window, as a CamStack
 * {@link DeviceType.Sensor} with the {@link DeviceRole.LeakSensor} role and the
 * existing `flood` cap (the same shape a moisture binary sensor takes elsewhere).
 * A CHILD of the gateway Hub device, following the window's node.
 *
 * The gateway reports rain as an opening limitation on the window, which it does
 * not push; the gateway client re-reads it when the window stops and on a slow
 * timer, and that arrives here through the same snapshot fan-out as positions.
 * An unknown reading keeps the last level.
 */
export class VeluxRainSensorDevice extends BaseDevice<typeof veluxRainSensorSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly nodeId: number
  private readonly serial: string
  private readonly gatewayId: string
  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = veluxRainSensorSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, veluxRainSensorSchema, {
      type: DeviceType.Sensor,
      role: DeviceRole.LeakSensor,
    })
    this.nodeId = cfg.nodeId
    this.serial = cfg.serial
    this.gatewayId = cfg.gatewayId
    this.online = this.liveNode()?.online ?? false
    const provider: InferNativeProvider<typeof floodCapability> = {
      getStatus: async () => this.runtimeState.getCapState<FloodStatus>('flood') ?? DRY,
    }
    this.ctx.registerNativeCap(floodCapability, provider)
    // Keep a restored level: inventing "dry" over a stored "wet" is a false falling edge.
    this.runtimeState.setCapState(
      'flood',
      this.runtimeState.getCapState<FloodStatus>('flood') ?? DRY,
    )
    void this.updateSourceInfo({
      id: `${this.gatewayId}:${this.serial.length > 0 ? this.serial : this.nodeId}:rain`,
      system: 'velux',
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.snapshotUnsub = veluxGateways.onSnapshot(this.gatewayId, () => {
      try {
        this.recomputeSlice()
      } catch (err) {
        this.ctx.logger.warn('velux rain sensor: snapshot handler error', {
          tags: { deviceId: this.id },
          meta: { nodeId: this.nodeId, error: errMsg(err) },
        })
      }
    })
    this.recomputeSlice()
  }

  override async removeDevice(): Promise<void> {
    this.snapshotUnsub?.()
    this.snapshotUnsub = null
    await super.removeDevice()
  }

  private liveNode(): VeluxNode | null {
    return veluxGateways.findNode(this.gatewayId, {
      serial: this.serial,
      nodeId: this.nodeId,
    })
  }

  private recomputeSlice(): void {
    const node = this.liveNode()
    if (node === null) return
    if (this.online !== node.online) this.markOnline(node.online)
    const prior = this.runtimeState.getCapState<FloodStatus>('flood') ?? DRY
    this.runtimeState.setCapState('flood', nodeToFloodStatus(node, prior, Date.now()))
  }
}
