import {
  BaseDevice,
  type DeviceContext,
  type DeviceFeature,
  DeviceType,
  energySystemCapability,
  type EnergySystemStatus,
  errMsg,
  type IDevice,
  type InferNativeProvider,
} from '@camstack/types'
import { z } from 'zod'
import { ENPAL_SYSTEM } from '../config.js'
import { computeEnergySystemStatus, EnergySystemCounterGuards } from '../enpal-energy-system.js'
import { enpalConnections } from '../enpal-resolver.js'

const CAP = energySystemCapability.name

/** Before the first poll: no part known, and no reading claimed. */
const COLD: EnergySystemStatus = {
  solar: null,
  grid: null,
  house: null,
  heatPump: null,
  storage: null,
  lastFetchedAt: 0,
}

/** Persisted config of the Energy system child: the integration whose box feeds it. */
export const enpalEnergySystemSchema = z.object({
  integrationId: z.string().min(1).describe('Owning integration'),
  system: z.literal(ENPAL_SYSTEM).optional(),
})

/**
 * The System's {@link DeviceType.EnergySystem} child (#513): every value the box reads —
 * production, grid, house, heat pump, storage — on one `energy-system` slice, recomputed
 * on every poll. It never registers `battery`: the storage is a field of the model (#522).
 *
 * An unreachable box marks it offline and leaves the slice alone: a failed read is a gap,
 * never a zero (D393). Lifetime counters pass through {@link EnergySystemCounterGuards}.
 */
export class EnpalEnergySystemDevice extends BaseDevice<typeof enpalEnergySystemSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly integrationId: string
  private readonly counters = new EnergySystemCounterGuards()
  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = enpalEnergySystemSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, enpalEnergySystemSchema, { type: DeviceType.EnergySystem })
    this.integrationId = cfg.integrationId
    this.online = enpalConnections.getSnapshot(this.integrationId) !== null
    void this.updateSourceInfo({ id: `${this.integrationId}:energy-system`, system: ENPAL_SYSTEM })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    const provider: InferNativeProvider<typeof energySystemCapability> = {
      getStatus: async () => this.runtimeState.getCapState<EnergySystemStatus>(CAP) ?? COLD,
    }
    this.ctx.registerNativeCap(energySystemCapability, provider)
    this.runtimeState.setCapState(CAP, COLD)
    this.snapshotUnsub = enpalConnections.onSnapshot(this.integrationId, () => {
      try {
        this.recompute()
      } catch (err) {
        this.ctx.logger.warn('enpal energy system: snapshot handler failed', {
          tags: { deviceId: this.id },
          meta: { error: errMsg(err) },
        })
      }
    })
    this.recompute()
  }

  override async removeDevice(): Promise<void> {
    this.snapshotUnsub?.()
    this.snapshotUnsub = null
    await super.removeDevice()
  }

  private recompute(): void {
    const snapshot = enpalConnections.getSnapshot(this.integrationId)
    if (snapshot === null) {
      if (this.online) this.markOnline(false)
      return
    }
    if (!this.online) this.markOnline(true)
    const invert =
      enpalConnections.getManager(this.integrationId)?.connection.invertBatteryPower ?? false
    const { status, refusals } = computeEnergySystemStatus(
      snapshot,
      { invertBatteryPower: invert },
      snapshot.fetchedAt,
    )
    this.runtimeState.setCapState(CAP, this.counters.apply(status))
    for (const line of refusals) {
      this.ctx.logger.warn(`enpal energy system: reading not used, ${line}`, {
        tags: { deviceId: this.id },
      })
    }
  }
}

/** Constructor closure the kernel calls for the Energy system child of the System. */
export function enpalEnergySystemFactory(ctx: DeviceContext): IDevice {
  return new EnpalEnergySystemDevice(ctx)
}
