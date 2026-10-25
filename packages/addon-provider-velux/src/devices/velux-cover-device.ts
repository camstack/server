import {
  BaseDevice,
  coverCapability,
  type CoverStatus,
  type DeviceContext,
  DeviceFeature,
  DeviceType,
  errMsg,
  type InferNativeProvider,
} from '@camstack/types'
import { veluxCoverSchema } from '../config.js'
import type { VeluxGatewayClient, VeluxNode } from '../velux-client-contract.js'
import { veluxGateways } from '../velux-node-resolver.js'

const COLD_START: CoverStatus = {
  state: 'closed',
  position: null,
  tiltPosition: null,
  lastChangedAt: 0,
}

/**
 * One Velux KLF-200 actuator (window or roller shutter) as a CamStack
 * {@link DeviceType.Cover} device. A CHILD of the gateway Hub device (standalone
 * mode). Registers ONE cap (`cover`) with the positional lifecycle surface
 * (open/close/stop/setPosition). Velux actuators are positional with NO tilt, so
 * `setTiltPosition` is intentionally omitted and `CoverTilt` is never advertised.
 *
 * The slice is fed from the live gateway node handle on each poll tick (and
 * seeded cold on activate). Commands are driven through the live client resolved
 * from {@link veluxGateways}.
 */
export class VeluxCoverDevice extends BaseDevice<typeof veluxCoverSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.CoverPositionable]

  private readonly nodeId: number
  private readonly gatewayId: string

  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = veluxCoverSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, veluxCoverSchema, { type: DeviceType.Cover })
    this.nodeId = cfg.nodeId
    this.gatewayId = cfg.gatewayId
    this.online = veluxGateways.getNode(this.gatewayId, this.nodeId)?.online ?? false
    this.registerCoverCap()
    this.runtimeState.setCapState('cover', COLD_START)
    void this.updateSourceInfo({ id: `${this.gatewayId}:${this.nodeId}`, system: 'velux' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.attachSnapshotListener()
    this.recomputeSlice()
  }

  override async removeDevice(): Promise<void> {
    if (this.snapshotUnsub) {
      try {
        this.snapshotUnsub()
      } catch {
        // best-effort
      }
      this.snapshotUnsub = null
    }
    await super.removeDevice()
  }

  /** Subscribe to per-gateway poll ticks. Works even before the manager exists —
   *  `recomputeSlice` no-ops on a missing node and replays once it appears. */
  private attachSnapshotListener(): void {
    const onSnapshot = (): void => {
      try {
        this.recomputeSlice()
      } catch (err) {
        this.ctx.logger.warn('velux cover: snapshot handler error', {
          meta: { nodeId: this.nodeId, error: errMsg(err) },
        })
      }
    }
    this.snapshotUnsub = veluxGateways.onSnapshot(this.gatewayId, onSnapshot)
  }

  /** Recompute + write this cover's `cover` cap slice from the live node. */
  private recomputeSlice(): void {
    const node = veluxGateways.getNode(this.gatewayId, this.nodeId)
    if (node === null) return
    if (this.online !== node.online) this.markOnline(node.online)
    this.runtimeState.setCapState('cover', nodeToCoverStatus(node, Date.now()))
  }

  private resolveClient(): VeluxGatewayClient {
    const client = veluxGateways.getManager(this.gatewayId)?.client ?? null
    if (client === null) {
      throw new Error(
        `Velux cover ${this.nodeId}: gateway ${this.gatewayId} client is not available`,
      )
    }
    return client
  }

  private registerCoverCap(): void {
    const provider: InferNativeProvider<typeof coverCapability> = {
      getStatus: async () => this.runtimeState.getCapState<CoverStatus>('cover') ?? COLD_START,
      open: async () => {
        await this.resolveClient().open(this.nodeId)
      },
      close: async () => {
        await this.resolveClient().close(this.nodeId)
      },
      stop: async () => {
        await this.resolveClient().stop(this.nodeId)
      },
      setPosition: async ({ position }) => {
        await this.resolveClient().setPosition(this.nodeId, position)
      },
      // Velux actuators have no tilt — the cap method is a no-op that reports the
      // unsupported surface honestly.
      setTiltPosition: async () => {
        throw new Error('velux: this actuator does not support tilt')
      },
    }
    this.ctx.registerNativeCap(coverCapability, provider)
  }
}

/** Map a live Velux node onto the `cover` cap status. Positional, no tilt. */
function nodeToCoverStatus(node: VeluxNode, now: number): CoverStatus {
  const position = node.position
  const state: CoverStatus['state'] = position === null || position <= 0 ? 'closed' : 'open'
  return {
    state,
    position,
    tiltPosition: null,
    lastChangedAt: now,
  }
}
