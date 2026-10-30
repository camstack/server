import { z } from 'zod'
import {
  BaseDevice,
  DeviceFeature,
  DeviceType,
  type AccessoryChildSpec,
  type DeviceContext,
} from '@camstack/types'
import type { Homematic, HmDevice, ValueChangedEvent } from 'nodehomematic'
import { homematicFacades } from '../homematic-facade-resolver.js'
import { mapMaintenanceChannel, readReachability } from '../homematic-diagnostics-mapping.js'
import { deriveHmEntitySpecs, type HmEntitySpec } from './hm-entity-spec.js'
import { hmChildFactoryForSpec } from './hm-child-class-factory.js'

/**
 * Persisted config for a Homematic Container (the parent of one physical CCU
 * device). `address` resolves the live `HmDevice` from the facade;
 * `integrationId` selects the CCU session (the connection lives on the
 * integration) and is stamped onto every child. The Container
 * derives its children LIVE from the facade descriptor (mirrors
 * `HaContainerDevice` reading live config) — the lib holds the full device
 * graph, so no `entities[]` summary is persisted.
 */
export const hmContainerSchema = z.object({
  address: z.string().min(1).describe('CCU device address'),
  integrationId: z.string().min(1).describe('Integration (CCU session) the device belongs to'),
  /** Adoption provenance markers (kept for cascade-remove + offline filter). */
  system: z.literal('homematic').optional(),
  hmAddress: z.string().optional(),
})

export type HmContainerConfig = z.infer<typeof hmContainerSchema>

/** Reachability MAINTENANCE params the container watches to derive `online`. */
const REACHABILITY_PARAMS: ReadonlySet<string> = new Set(['UNREACH', 'STICKY_UNREACH'])

/**
 * Parent Container device for a single Homematic physical device. Owns no
 * control caps itself — it declares `getAccessoryChildren()` so the kernel
 * auto-spawns one accessory child per functional entity (actuator / sensor /
 * event-emitter / diagnostic / firmware-update) and reconciles additions /
 * removals across reboots. Mirrors `HaContainerDevice`.
 */
export class HmContainerDevice extends BaseDevice<typeof hmContainerSchema> {
  // `Resyncable` drives the generic Re-sync button; `BatteryOperated` is
  // appended when the device carries a battery / voltage diagnostic (derived
  // from the live MAINTENANCE descriptor in the constructor).
  readonly features: readonly DeviceFeature[]

  private readonly address: string
  private readonly integrationId: string

  /** Unsubscribe for the facade `valueChanged` reachability listener. */
  private valueChangedUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = hmContainerSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, hmContainerSchema, { type: DeviceType.Container })
    this.address = cfg.address
    this.integrationId = cfg.integrationId

    const hmDevice = this.resolveHmDevice()
    this.features = HmContainerDevice.deriveFeatures(hmDevice)

    // Cold start: derive online from the current reachability snapshot; if the
    // device is present but reachability is unknown, default online=true.
    this.online = this.deriveOnline(hmDevice)
    this.attachReachabilityListener()

    void this.updateSourceInfo({ id: this.address, system: 'homematic' })
  }

  /** A device is battery-operated when its MAINTENANCE channel exposes a
   *  battery / operating-voltage diagnostic. */
  private static deriveFeatures(hmDevice: HmDevice | null): readonly DeviceFeature[] {
    if (!hmDevice) return [DeviceFeature.Resyncable]
    const diagnostics = mapMaintenanceChannel(hmDevice)
    const hasBattery = diagnostics.some(
      (e) => e.key === 'maint-voltage' || e.key === 'maint-battery-low',
    )
    return hasBattery
      ? [DeviceFeature.Resyncable, DeviceFeature.BatteryOperated]
      : [DeviceFeature.Resyncable]
  }

  // ── facade resolution ──────────────────────────────────────────────────

  private get facade(): Homematic | null {
    return homematicFacades.get(this.integrationId)
  }

  private resolveHmDevice(): HmDevice | null {
    const facade = this.facade
    if (!facade) return null
    return facade.devices().find((d) => d.address === this.address) ?? null
  }

  // ── online (derived from reachability) ──────────────────────────────────

  /** `online = !unreach`; when reachability is unknown but the device is
   *  present, default to true. */
  private deriveOnline(hmDevice: HmDevice | null): boolean {
    if (!hmDevice) return false
    const reach = readReachability(hmDevice)
    if (reach === null) return true
    return !reach.unreach
  }

  private attachReachabilityListener(): void {
    const facade = this.facade
    if (!facade) return
    this.valueChangedUnsub = facade.on('valueChanged', (event: ValueChangedEvent) => {
      if (event.device !== this.address) return
      if (!REACHABILITY_PARAMS.has(event.parameter.toUpperCase())) return
      const next = !event.value
      if (this.online !== next) this.markOnline(next)
    })
  }

  override async removeDevice(): Promise<void> {
    if (this.valueChangedUnsub) {
      try {
        this.valueChangedUnsub()
      } catch {
        // best-effort
      }
      this.valueChangedUnsub = null
    }
  }

  /**
   * Stamp `feature-probe.lastProbedAt` only when the CCU device is on the
   * facade. An empty accessory-spec list + a stamped probe is how the kernel
   * orphan-prunes linked children (`device-cap-proxy` safety gate): a restore
   * that races a CCU `ECONNREFUSED` used to delete every accessory and fence
   * their identities for 5 minutes. Leaving `lastProbedAt === 0` until the
   * device is present keeps the gate closed; `reprobe()` on session connect
   * completes the probe and spawns/reconciles children for real.
   */
  override async onProbe(): Promise<void> {
    if (this.resolveHmDevice() === null) return
    await super.onProbe()
  }

  // ── accessory children (derived LIVE from the facade descriptor) ─────────

  /**
   * Derive the accessory children LIVE from the facade descriptor. Each child
   * is a {@link HmEntitySpec} (the shared per-entity decomposition) wrapped into
   * an `AccessoryChildSpec`: the `stableIdSuffix` IS the spec `key`, the
   * integration FK + the CCU `address` are stamped onto config, and the
   * concrete child class is resolved from the spec via `hmChildFactoryForSpec`.
   */
  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    const hmDevice = this.resolveHmDevice()
    if (!hmDevice) {
      this.ctx.logger.debug('HmContainerDevice: device not on facade; no children yet', {
        meta: { address: this.address },
      })
      return []
    }
    const customEntities =
      this.facade?.customEntities()?.filter((e) => e.device === this.address) ?? []
    const specs = deriveHmEntitySpecs(hmDevice, customEntities)
    // The PRIMARY (actuator) entity inherits the device's display name — like
    // Home Assistant, where the main entity shares the device name (e.g. the
    // cover shows "Tapparella", not "cover 00111BE992A8E5:4"). Support entities
    // (sensors / diagnostics / events / firmware) keep their descriptive names.
    // When a device has MULTIPLE actuators, disambiguate with the channel index.
    const actuatorKeys = specs.filter((s) => s.key.startsWith('act-')).map((s) => s.key)
    const multipleActuators = actuatorKeys.length > 1
    return specs.map((spec) => {
      if (!spec.key.startsWith('act-')) return this.childSpec(spec)
      const suffix = multipleActuators ? ` ${spec.key.slice('act-'.length)}` : ''
      return this.childSpec(spec, `${this.name}${suffix}`)
    })
  }

  // ── spec assembly ───────────────────────────────────────────────────────

  /** Wrap one {@link HmEntitySpec} into an accessory-child spec, stamping the
   *  CCU `address` + integration FK onto config and the container link
   *  + integration + type/role onto meta. */
  private childSpec(spec: HmEntitySpec, nameOverride?: string): AccessoryChildSpec {
    const role = spec.role !== null ? String(spec.role) : undefined
    const meta: AccessoryChildSpec['meta'] = {
      type: spec.deviceType,
      name: nameOverride ?? spec.name,
      linkDeviceId: this.id,
      integrationId: this.integrationId,
      ...(role !== undefined ? { role } : {}),
    }
    const config: Record<string, unknown> = {
      ...spec.config,
      address: this.address,
      integrationId: this.integrationId,
    }
    return {
      stableIdSuffix: spec.key,
      meta,
      config,
      factory: hmChildFactoryForSpec(spec),
    }
  }
}
