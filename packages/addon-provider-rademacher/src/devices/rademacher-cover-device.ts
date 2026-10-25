import type { CoverDevice } from '@apocaliss92/noderademacher'
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
import { rademacherCoverSchema } from '../config.js'
import { type RademacherCoverSnapshot, toCoverStatus, toLibraryPosition } from '../cover-mapping.js'
import { rademacherHubs } from '../rademacher-hub-resolver.js'

const COLD_START: CoverStatus = {
  state: 'closed',
  position: null,
  tiltPosition: null,
  lastChangedAt: 0,
}

/**
 * One Rademacher HomePilot roller shutter as a CamStack {@link DeviceType.Cover}
 * device. A CHILD of the hub Hub device (standalone mode). Registers ONE cap
 * (`cover`) with the full lifecycle surface (open/close/stop/setPosition +
 * setTiltPosition for slat-tilt / ventilation). The slice is fed from the live
 * hub client handle on each poll tick (and seeded cold on activate).
 *
 * Position + tilt are mapped through {@link toCoverStatus}, which applies the
 * per-device inversion (`invertPosition`) for HomePilot units that report an
 * already-HA-oriented position (`inverted_cover_position`). See
 * `cover-mapping.ts` for the full inversion rationale.
 *
 * Features are derived from the device's probed support: `CoverPositionable`
 * (SET_POSITION, always advertised by these shutters) and `CoverTilt` (slat /
 * ventilation, when the device advertises SET_SLAT_POS_CMD).
 */
export class RademacherCoverDevice extends BaseDevice<typeof rademacherCoverSchema> {
  readonly features: readonly DeviceFeature[]

  private readonly did: string
  private readonly hubId: string
  private readonly invertPosition: boolean
  private readonly supportsTilt: boolean

  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = rademacherCoverSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, rademacherCoverSchema, { type: DeviceType.Cover })
    this.did = cfg.did
    this.hubId = cfg.hubId
    this.invertPosition = cfg.invertPosition
    this.supportsTilt = cfg.supportsTilt

    const features: DeviceFeature[] = []
    if (cfg.supportsPosition) features.push(DeviceFeature.CoverPositionable)
    if (cfg.supportsTilt) features.push(DeviceFeature.CoverTilt)
    this.features = features

    this.online = rademacherHubs.getCover(this.hubId, this.did)?.online ?? false
    this.registerCoverCap()
    this.runtimeState.setCapState('cover', COLD_START)
    void this.updateSourceInfo({ id: this.did, system: 'rademacher' })
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

  /** Subscribe to per-hub poll ticks (recompute this cover's slice). Works even
   *  before the manager exists — `recomputeSlice` no-ops on a missing handle and
   *  replays once the hub pumps the first snapshot. */
  private attachSnapshotListener(): void {
    const onSnapshot = (): void => {
      try {
        this.recomputeSlice()
      } catch (err) {
        this.ctx.logger.warn('rademacher cover: snapshot handler error', {
          meta: { did: this.did, error: errMsg(err) },
        })
      }
    }
    this.snapshotUnsub = rademacherHubs.onSnapshot(this.hubId, onSnapshot)
  }

  /** Recompute + write this cover's `cover` cap slice from the live handle. */
  private recomputeSlice(): void {
    const handle = rademacherHubs.getCover(this.hubId, this.did)
    if (handle === null) return
    if (this.online !== handle.online) this.markOnline(handle.online)
    const snapshot = snapshotFromHandle(handle, this.supportsTilt)
    const status = toCoverStatus(snapshot, { invertPosition: this.invertPosition }, Date.now())
    this.runtimeState.setCapState('cover', status)
  }

  private resolveHandle(): CoverDevice {
    const handle = rademacherHubs.getCover(this.hubId, this.did)
    if (handle === null) {
      throw new Error(`Rademacher cover ${this.did}: hub ${this.hubId} client is not available`)
    }
    return handle
  }

  private registerCoverCap(): void {
    const provider: InferNativeProvider<typeof coverCapability> = {
      getStatus: async () => this.runtimeState.getCapState<CoverStatus>('cover') ?? COLD_START,
      open: async () => {
        await this.resolveHandle().open()
      },
      close: async () => {
        await this.resolveHandle().close()
      },
      stop: async () => {
        await this.resolveHandle().stop()
      },
      setPosition: async ({ position }) => {
        await this.resolveHandle().setPosition(toLibraryPosition(position, this.invertPosition))
      },
      setTiltPosition: async ({ tiltPosition }) => {
        await this.resolveHandle().setTilt(toLibraryPosition(tiltPosition, this.invertPosition))
      },
    }
    this.ctx.registerNativeCap(coverCapability, provider)
  }
}

/** Build a normalized snapshot from a live library cover handle. */
function snapshotFromHandle(handle: CoverDevice, supportsTilt: boolean): RademacherCoverSnapshot {
  return {
    position: handle.position ?? null,
    tiltPosition: handle.slatPosition ?? null,
    supportsTilt,
    online: handle.online,
  }
}
