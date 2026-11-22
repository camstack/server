import { z } from 'zod'
import {
  BaseDevice,
  DeviceFeature,
  DeviceType,
  type AccessoryChildSpec,
  type ConsumablesStatus,
  type DeviceContext,
  type InferNativeProvider,
  type LocationStatus,
  type VehicleRefreshResult,
  type VehicleStatus,
  consumablesCapability,
  emptyLocationStatus,
  emptyVehicleStatus,
  errMsg,
  locationCapability,
  resyncCapability,
  resyncThroughAdoption,
  vehicleCapability,
} from '@camstack/types'
import type { KiaVehicleHandle } from '../kia-device-handle.js'
import { kiaConnections } from '../kia-gateway.js'
import { consumablesStatusOf, locationStatusOf, vehicleStatusOf } from '../kia-domain-mapping.js'
import { kiaIdentifiers } from '../kia-identifiers.js'
import { registerKiaStateRefresh } from '../kia-state-refresh.js'
import { kiaAccessoryChildren } from './kia-accessory-children.js'

/**
 * Persisted config of a Kia vehicle. `kiaVehicleId` resolves the live handle from the
 * connection resolver; `brokerId` selects the account (it holds the integration id, a name that
 * predates integration instances and stays, it is stored on adopted devices); `model` is the
 * cloud model string; `system`/`name` are provenance.
 */
export const kiaVehicleSchema = z.object({
  kiaVehicleId: z.string().min(1).describe('Kia cloud vehicle id'),
  brokerId: z.string().min(1).describe('Integration id (persisted under the legacy name brokerId)'),
  model: z.string().optional().describe('Kia cloud model string'),
  integrationId: z.string().optional(),
  system: z.literal('kia').optional(),
  name: z.string().optional(),
})
export type KiaVehicleConfig = z.infer<typeof kiaVehicleSchema>

const VEHICLE_CAP = 'vehicle'
const LOCATION_CAP = 'location'
const CONSUMABLES_CAP = 'consumables'

/**
 * One connected car: the `vehicle`, `location` and `consumables` caps, fed by the integration
 * manager's handle. Lock and climate are accessory children (D1079).
 *
 * Everything is what the car last REPORTED to its maker's cloud, so it can be hours old
 * (`reportedAt` says when). A cap the cloud says nothing about stays null, never 0 (D393).
 */
export class KiaVehicleDevice extends BaseDevice<typeof kiaVehicleSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.Resyncable]

  protected readonly kiaVehicleId: string
  protected readonly integrationId: string
  private readonly model: string | undefined
  private readonly listedIntegrationId: string | undefined
  private readonly handleUnsubs: Array<() => void> = []

  constructor(ctx: DeviceContext) {
    const cfg = kiaVehicleSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, kiaVehicleSchema, { type: DeviceType.Vehicle })
    this.ctx.registerNativeCap(
      resyncCapability,
      resyncThroughAdoption(this.ctx.api.deviceManager, this.id),
    )
    this.kiaVehicleId = cfg.kiaVehicleId
    this.integrationId = cfg.brokerId
    this.model = cfg.model
    this.listedIntegrationId = cfg.integrationId
    this.online = kiaConnections.getVehicle(this.integrationId, this.kiaVehicleId) !== null
    void this.updateSourceInfo({ id: this.kiaVehicleId, system: 'kia' })
  }

  private resolveHandle(): KiaVehicleHandle | null {
    return kiaConnections.getVehicle(this.integrationId, this.kiaVehicleId)
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    void this.declareVendorIdentity()
    this.registerCaps()
    registerKiaStateRefresh({
      ctx: this.ctx,
      integrationId: this.integrationId,
      readAccount: (reason) => kiaConnections.refresh(this.integrationId, reason),
    })
    const handle = this.resolveHandle()
    if (handle === null) {
      this.ctx.logger.debug('KiaVehicleDevice: handle not present; no live listener yet', {
        tags: { deviceId: this.id },
      })
      return
    }
    this.handleUnsubs.push(handle.onChange(() => this.safeRecompute()))
    this.recomputeSlices()
  }

  override async removeDevice(): Promise<void> {
    for (const unsub of this.handleUnsubs.splice(0)) {
      try {
        unsub()
      } catch {
        // best-effort — the device is being torn down regardless
      }
    }
  }

  /** Declare the cloud vehicle id as a `vendor-uid` (D1059). */
  private async declareVendorIdentity(): Promise<void> {
    const declaration = kiaIdentifiers(this.kiaVehicleId)
    if (declaration === null) return
    await this.declareIdentifiers(declaration.identifiers, { unread: declaration.unread })
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    return kiaAccessoryChildren({
      name: this.name,
      deviceId: this.id,
      kiaVehicleId: this.kiaVehicleId,
      brokerId: this.integrationId,
      model: this.model,
      integrationId: this.listedIntegrationId,
    })
  }

  private seed<T extends { readonly lastChangedAt: number }>(cap: string, cold: T): void {
    // The caps are restored across a restart: seed only a slice nothing has written yet.
    if (this.runtimeState.getCapState<T>(cap) === undefined) {
      this.runtimeState.setCapState(cap, { ...cold, lastFetchedAt: 0 })
    }
  }

  private registerCaps(): void {
    const vehicleProvider: InferNativeProvider<typeof vehicleCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<VehicleStatus>(VEHICLE_CAP) ?? emptyVehicleStatus(),
      requestRefresh: async (): Promise<VehicleRefreshResult> => this.requestRefresh(),
    }
    this.ctx.registerNativeCap(vehicleCapability, vehicleProvider)
    this.seed(VEHICLE_CAP, emptyVehicleStatus())

    const locationProvider: InferNativeProvider<typeof locationCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<LocationStatus>(LOCATION_CAP) ?? emptyLocationStatus(),
    }
    this.ctx.registerNativeCap(locationCapability, locationProvider)
    this.seed(LOCATION_CAP, emptyLocationStatus())

    const consumablesProvider: InferNativeProvider<typeof consumablesCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<ConsumablesStatus>(CONSUMABLES_CAP) ?? {
          items: [],
          lastChangedAt: 0,
        },
      // Nothing here is resettable: the car's own counters decide.
      reset: async () => {
        throw new Error('A Kia vehicle consumable is reported by the car and cannot be reset here')
      },
    }
    this.ctx.registerNativeCap(consumablesCapability, consumablesProvider)
    this.seed(CONSUMABLES_CAP, { items: [], lastChangedAt: 0 })
  }

  /** `vehicle.requestRefresh`: waking the car costs quota, so the answer is typed and logged. */
  private async requestRefresh(): Promise<VehicleRefreshResult> {
    const handle = this.resolveHandle()
    if (handle === null) {
      this.ctx.logger.warn('KiaVehicleDevice: refresh refused — no cloud connection', {
        tags: { deviceId: this.id },
      })
      return { ok: false, reason: 'account-error', retryAt: null }
    }
    const result = await handle.requestRefresh()
    if (result.ok) {
      this.ctx.logger.info('KiaVehicleDevice: forced refresh answered', {
        tags: { deviceId: this.id },
        meta: { reportedAt: result.reportedAt },
      })
    } else {
      this.ctx.logger.warn('KiaVehicleDevice: forced refresh refused', {
        tags: { deviceId: this.id },
        meta: { reason: result.reason, retryAt: result.retryAt },
      })
    }
    return result
  }

  private safeRecompute(): void {
    try {
      this.recomputeSlices()
    } catch (err) {
      this.ctx.logger.warn('KiaVehicleDevice: state change handler error', {
        tags: { deviceId: this.id },
        meta: { error: errMsg(err) },
      })
    }
  }

  /** Write the three slices from the handle's last reported state. */
  private recomputeSlices(): void {
    const handle = this.resolveHandle()
    if (handle === null) return
    const state = handle.state
    const now = Date.now()
    const previousVehicle = this.runtimeState.getCapState<VehicleStatus>(VEHICLE_CAP)
    const previousLocation = this.runtimeState.getCapState<LocationStatus>(LOCATION_CAP)
    const previousConsumables = this.runtimeState.getCapState<ConsumablesStatus>(CONSUMABLES_CAP)
    this.runtimeState.setCapState(VEHICLE_CAP, {
      ...vehicleStatusOf(state, now, previousVehicle),
      lastFetchedAt: now,
    })
    this.runtimeState.setCapState(LOCATION_CAP, {
      ...locationStatusOf(state, now, previousLocation),
      lastFetchedAt: now,
    })
    this.runtimeState.setCapState(CONSUMABLES_CAP, {
      ...consumablesStatusOf(state, now, previousConsumables),
      lastFetchedAt: now,
    })
  }
}
