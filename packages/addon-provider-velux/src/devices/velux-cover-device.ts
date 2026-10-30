import {
  BaseDevice,
  type CoverStatus,
  coverCapability,
  type DeviceContext,
  DeviceFeature,
  DeviceType,
  errMsg,
  type InferNativeProvider,
} from '@camstack/types'
import { veluxCoverSchema } from '../config.js'
import type { VeluxGatewayClient, VeluxNode } from '../velux-client-contract.js'
import { veluxGateways } from '../velux-node-resolver.js'
import { nodeToCoverStatus } from '../velux-protocol.js'

/** Before the first report from the gateway nothing is known: not "closed". */
const COLD_START: CoverStatus = {
  state: 'stopped',
  position: null,
  tiltPosition: null,
  lastChangedAt: 0,
}

/**
 * One Velux KLF-200 actuator (window or roller shutter) as a CamStack
 * {@link DeviceType.Cover} device: a top-level device of its integration, or the
 * cover inside a window container. Registers ONE cap (`cover`) with the positional lifecycle surface
 * (open/close/stop/setPosition). Velux actuators are positional with NO tilt, so
 * `setTiltPosition` is intentionally omitted and `CoverTilt` is never advertised.
 *
 * The slice is fed from the live gateway node on each push (and
 * seeded cold on activate). Commands are driven through the live client resolved
 * from {@link veluxGateways}.
 */
export class VeluxCoverDevice extends BaseDevice<typeof veluxCoverSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.CoverPositionable]

  private readonly nodeId: number
  private readonly serial: string
  private readonly integrationId: string

  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = veluxCoverSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, veluxCoverSchema, { type: DeviceType.Cover })
    this.nodeId = cfg.nodeId
    this.serial = cfg.serial
    this.integrationId = cfg.integrationId
    this.online = this.liveNode()?.online ?? false
    this.registerCoverCap()
    this.runtimeState.setCapState('cover', COLD_START)
    void this.updateSourceInfo({
      id:
        this.serial.length > 0
          ? `${this.integrationId}:${this.serial}`
          : `${this.integrationId}:${this.nodeId}`,
      system: 'velux',
    })
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

  /** Subscribe to the integration's change ticks. Works even before the manager exists —
   *  `recomputeSlice` no-ops on a missing node and replays once it appears. */
  private attachSnapshotListener(): void {
    const onSnapshot = (): void => {
      try {
        this.recomputeSlice()
      } catch (err) {
        this.ctx.logger.warn('velux cover: snapshot handler error', {
          tags: { deviceId: this.id },
          meta: { nodeId: this.nodeId, error: errMsg(err) },
        })
      }
    }
    this.snapshotUnsub = veluxGateways.onSnapshot(this.integrationId, onSnapshot)
  }

  /** Recompute + write this cover's `cover` cap slice from the live node. */
  private recomputeSlice(): void {
    const node = this.liveNode()
    if (node === null) return
    if (this.online !== node.online) this.markOnline(node.online)
    const prior = this.runtimeState.getCapState<CoverStatus>('cover') ?? COLD_START
    const next = nodeToCoverStatus(node, Date.now())
    // The change time moves only when the cover actually changed, not on every push.
    const unchanged = prior.state === next.state && prior.position === next.position
    this.runtimeState.setCapState('cover', unchanged ? prior : next)
  }

  private liveNode(): VeluxNode | null {
    return veluxGateways.findNode(this.integrationId, {
      serial: this.serial,
      nodeId: this.nodeId,
    })
  }

  /** Node id to command: the live one, since a serial-keyed node may have been renumbered. */
  private liveNodeId(): number {
    return this.liveNode()?.nodeId ?? this.nodeId
  }

  private resolveClient(): VeluxGatewayClient {
    const client = veluxGateways.getManager(this.integrationId)?.client ?? null
    if (client === null) {
      throw new Error(
        `Velux cover ${this.nodeId}: integration ${this.integrationId} has no live gateway session`,
      )
    }
    return client
  }

  private registerCoverCap(): void {
    const provider: InferNativeProvider<typeof coverCapability> = {
      getStatus: async () => this.runtimeState.getCapState<CoverStatus>('cover') ?? COLD_START,
      open: async () => {
        await this.resolveClient().open(this.liveNodeId())
      },
      close: async () => {
        await this.resolveClient().close(this.liveNodeId())
      },
      stop: async () => {
        await this.resolveClient().stop(this.liveNodeId())
      },
      setPosition: async ({ position }) => {
        await this.resolveClient().setPosition(this.liveNodeId(), position)
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
