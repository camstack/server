import {
  BaseDevice,
  DeviceFeature,
  DeviceRole,
  type ClimateControlStatus,
  type DeviceContext,
  type InferNativeProvider,
  type LockControlStatus,
  climateControlCapability,
  errMsg,
  lockControlCapability,
} from '@camstack/types'
import type { KiaVehicleHandle } from '../kia-device-handle.js'
import { climateStatusOf, lockStateOf } from '../kia-domain-mapping.js'
import { kiaConnections } from '../kia-gateway.js'
import { createKiaClimateProvider, createKiaLockProvider } from '../kia-vehicle-commands.js'
import { kiaVehicleSchema } from './kia-vehicle-device.js'

const LOCK_CAP = 'lock-control'
const CLIMATE_CAP = 'climate-control'

/**
 * One accessory of a car (D1079): the lock or the cabin climate. It reads the car's handle, the
 * same one the vehicle device reads, and writes its slice only from what the cloud REPORTED. A
 * command is sent and forgotten; the readback the manager folds into the handle is what moves the
 * slice (D1061), and a state the cloud does not report leaves the slice unwritten rather than
 * guessed (D393).
 */
abstract class KiaAccessoryDevice extends BaseDevice<typeof kiaVehicleSchema> {
  readonly features: readonly DeviceFeature[] = []

  protected readonly kiaVehicleId: string
  protected readonly integrationId: string
  private handleUnsub: (() => void) | null = null

  protected constructor(ctx: DeviceContext, role: DeviceRole) {
    const cfg = kiaVehicleSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, kiaVehicleSchema, { type: ctx.deviceMeta.type, role })
    this.kiaVehicleId = cfg.kiaVehicleId
    this.integrationId = cfg.brokerId
    this.online = this.resolveHandle() !== null
    void this.updateSourceInfo({ id: this.kiaVehicleId, system: 'kia' })
  }

  protected resolveHandle(): KiaVehicleHandle | null {
    return kiaConnections.getVehicle(this.integrationId, this.kiaVehicleId)
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerCaps()
    // The watch outlives any one handle: a late first sign-in or a reconnect rebinds it.
    this.handleUnsub = kiaConnections.watchVehicle(this.integrationId, this.kiaVehicleId, () =>
      this.safeRecompute(),
    )
    this.safeRecompute()
  }

  override async removeDevice(): Promise<void> {
    try {
      this.handleUnsub?.()
    } catch {
      // best-effort — the device is being torn down regardless
    }
    this.handleUnsub = null
  }

  protected abstract registerCaps(): void
  protected abstract recompute(handle: KiaVehicleHandle): void

  private safeRecompute(): void {
    const handle = this.resolveHandle()
    if (handle === null) return
    try {
      this.recompute(handle)
    } catch (err: unknown) {
      this.ctx.logger.warn('Kia accessory: state change handler error', {
        tags: { deviceId: this.id },
        meta: { error: errMsg(err) },
      })
    }
  }
}

/** The car's central locking. */
export class KiaLockDevice extends KiaAccessoryDevice {
  constructor(ctx: DeviceContext) {
    super(ctx, DeviceRole.LockVehicle)
  }

  protected registerCaps(): void {
    const provider: InferNativeProvider<typeof lockControlCapability> = {
      ...createKiaLockProvider({
        deviceId: this.id,
        logger: this.ctx.logger,
        resolveHandle: () => this.resolveHandle(),
      }),
      getStatus: async () => {
        const slice = this.runtimeState.getCapState<LockControlStatus>(LOCK_CAP)
        // No lock state is better than a wrong one: the cloud has not said yet.
        if (slice === undefined) throw new Error('Kia: the car has not reported its lock state yet')
        return slice
      },
    }
    this.ctx.registerNativeCap(lockControlCapability, provider)
  }

  protected recompute(handle: KiaVehicleHandle): void {
    const state = lockStateOf(handle.state)
    if (state === null) return
    const previous = this.runtimeState.getCapState<LockControlStatus>(LOCK_CAP)
    if (previous?.state === state) return
    const now = Date.now()
    this.runtimeState.setCapState(LOCK_CAP, {
      state,
      // The PIN is the account's, held by the worker; a caller is never asked for one.
      codeRequired: false,
      lastChangedAt: now,
      lastFetchedAt: now,
    })
  }
}

/** The car's cabin climate. */
export class KiaClimateDevice extends KiaAccessoryDevice {
  constructor(ctx: DeviceContext) {
    super(ctx, DeviceRole.ClimateVehicle)
  }

  protected registerCaps(): void {
    const provider: InferNativeProvider<typeof climateControlCapability> = {
      ...createKiaClimateProvider({
        deviceId: this.id,
        logger: this.ctx.logger,
        resolveHandle: () => this.resolveHandle(),
      }),
      getStatus: async () => {
        const slice = this.runtimeState.getCapState<ClimateControlStatus>(CLIMATE_CAP)
        if (slice === undefined) {
          throw new Error('Kia: the car has not reported its climate state yet')
        }
        return slice
      },
    }
    this.ctx.registerNativeCap(climateControlCapability, provider)
  }

  protected recompute(handle: KiaVehicleHandle): void {
    const next = climateStatusOf(handle.state, Date.now())
    if (next === null) return
    this.runtimeState.setCapState(CLIMATE_CAP, next)
  }
}
