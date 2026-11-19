import { z } from 'zod'
import {
  BaseDevice,
  type AccessoryChildSpec,
  type BatteryStatus,
  batteryCapability,
  type DeviceContext,
  type DeviceFeature,
  type IDevice,
  type InferNativeProvider,
  type PowerMeterStatus,
  powerMeterCapability,
} from '@camstack/types'
import { registerUnraidAdminLink } from '../unraid-admin-link.js'
import { UNRAID_SYSTEM } from '../config.js'
import { findUps } from '../unraid-discovery.js'
import { unraidInstances } from '../unraid-node-resolver.js'
import { registerUnraidStateRefresh } from './unraid-state-refresh.js'
import { UnraidEntityIdentitySchema } from '../unraid-mapping.js'
import { upsBatteryStatus, upsPowerMeterStatus } from '../unraid-ups.js'
import { UnraidEntityDevice } from './unraid-entity-device.js'

/**
 * Persisted config of an adopted UPS. `upsLocalId` names it the way that survives on the
 * server (the local part of its PrefixedID); `entities[]` is the fixed list of readings that
 * fan out as accessory children.
 */
export const unraidUpsSchema = z.object({
  nativeId: z.string().min(1),
  integrationId: z.string().min(1).describe('Owning integration'),
  upsLocalId: z.string().min(1),
  entities: z.array(UnraidEntityIdentitySchema).default([]),
  system: z.literal(UNRAID_SYSTEM).optional(),
  name: z.string().optional(),
})

export type UnraidUpsConfig = z.infer<typeof unraidUpsSchema>

const COLD_BATTERY: BatteryStatus = {
  level: null,
  charging: 'unknown',
  sleeping: false,
  lastUpdated: 0,
}
const COLD_POWER: PowerMeterStatus = { lastFetchedAt: 0 }

/**
 * One UPS of an Unraid server, adopted on its own: a top-level `sensor` device (role `ups`),
 * a sibling of the server's Host. It serves `battery` (charge, charging source) and
 * `power-meter` (power drawn now) from the poll snapshot; status, runtime, health, load, the
 * voltages and the nominal power are its accessory children. A UPS the server stops listing
 * goes offline (a list that was read, not a failed read); an unanswered poll changes nothing.
 */
export class UnraidUpsDevice extends BaseDevice<typeof unraidUpsSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly integrationId: string
  private readonly upsLocalId: string
  private snapshotUnsub: (() => void) | null = null
  private stopStateRefresh: (() => void) | null = null
  private listed = true

  constructor(ctx: DeviceContext) {
    const cfg = unraidUpsSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, unraidUpsSchema, { type: ctx.deviceMeta.type })
    this.integrationId = cfg.integrationId
    this.upsLocalId = cfg.upsLocalId
    this.online = findUps(unraidInstances.getSnapshot(cfg.integrationId), cfg.upsLocalId) !== null
    void this.updateSourceInfo({
      id: `${cfg.integrationId}:${cfg.nativeId}`,
      system: UNRAID_SYSTEM,
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // The core decides when the server is re-read (D1062); this device only reads.
    this.stopStateRefresh ??= registerUnraidStateRefresh({
      ctx: this.ctx,
      deviceId: this.id,
      integrationId: this.integrationId,
    })
    const battery: InferNativeProvider<typeof batteryCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<BatteryStatus>(batteryCapability.name) ?? COLD_BATTERY,
    }
    const power: InferNativeProvider<typeof powerMeterCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<PowerMeterStatus>(powerMeterCapability.name) ?? COLD_POWER,
    }
    this.ctx.registerNativeCap(batteryCapability, battery)
    this.ctx.registerNativeCap(powerMeterCapability, power)
    this.runtimeState.setCapState(batteryCapability.name, COLD_BATTERY)
    this.runtimeState.setCapState(powerMeterCapability.name, COLD_POWER)
    // The UPS is configured in the same WebGUI as its server.
    registerUnraidAdminLink(this.ctx, this.id, {
      instanceId: this.integrationId,
    })
    this.snapshotUnsub = unraidInstances.onSnapshot(this.integrationId, () => this.recompute())
    this.recompute()
  }

  override async removeDevice(): Promise<void> {
    this.stopStateRefresh?.()
    this.stopStateRefresh = null
    this.snapshotUnsub?.()
    this.snapshotUnsub = null
    await super.removeDevice()
  }

  /** The `battery` and `power-meter` slices from the live snapshot. */
  private recompute(): void {
    const snapshot = unraidInstances.getSnapshot(this.integrationId)
    // A list that was not read says nothing about this UPS.
    if (snapshot?.ups === undefined || snapshot.ups === null) return
    const ups = findUps(snapshot, this.upsLocalId)
    if (ups === null) {
      if (this.listed) {
        this.listed = false
        this.ctx.logger.warn('unraid ups: not listed by the server, marked offline', {
          tags: { deviceId: this.id },
          meta: {
            upsLocalId: this.upsLocalId,
            integrationId: this.integrationId,
          },
        })
      }
      if (this.online) this.markOnline(false)
      return
    }
    this.listed = true
    if (!this.online) this.markOnline(true)
    const now = Date.now()
    this.runtimeState.setCapState(batteryCapability.name, upsBatteryStatus(ups, now))
    this.runtimeState.setCapState(powerMeterCapability.name, upsPowerMeterStatus(ups, now))
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    return this.config.values.entities.map((entity) => {
      const meta: AccessoryChildSpec['meta'] = {
        type: entity.deviceType,
        name: entity.name,
        linkDeviceId: this.id,
        ...(entity.role !== undefined ? { role: entity.role } : {}),
        integrationId: this.integrationId,
      }
      const config: Record<string, unknown> = {
        instanceId: this.integrationId,
        entityKey: entity.key,
        kind: entity.kind,
        capName: entity.capName,
        capabilities: [entity.capName],
        system: UNRAID_SYSTEM,
        upsLocalId: this.upsLocalId,
        integrationId: this.integrationId,
      }
      return {
        stableIdSuffix: entity.key,
        meta,
        config,
        factory: (childCtx: DeviceContext): IDevice => new UnraidEntityDevice(childCtx),
      } satisfies AccessoryChildSpec
    })
  }
}
