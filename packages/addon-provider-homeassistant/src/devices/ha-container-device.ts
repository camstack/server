import { registerHaAdminLink } from '../ha-admin-link.js'
import {
  type AccessoryChildSpec,
  BaseDevice,
  type BatteryStatus,
  batteryCapability,
  type DeviceContext,
  DeviceFeature,
  DeviceRole,
  DeviceType,
  EnumSensorDateTimeFormatSchema,
  errMsg,
  type IDevice,
  type InferNativeProvider,
  type RawStateResult,
} from '@camstack/types'
import { z } from 'zod'
import { pickHaChildClass, tryPickHaChildClass } from '../ha-child-class-factory.js'
import { deriveChildLayout } from '../ha-container-reconcile.js'
import { type HaEntityState, HaEntityStateSchema } from '../ha-types.js'

const haEntitySchema = z.object({
  entityId: z.string(),
  deviceType: z.enum(DeviceType),
  capabilities: z.array(z.string()),
  role: z.string().optional(),
  unitOfMeasurement: z.string().optional(),
  deviceClass: z.string().optional(),
  /** HA `options` attribute — present on select / input_select entities.
   *  Persisted at adoption so the control slice is seeded immediately. */
  options: z.array(z.string()).optional(),
  /** Mapping-derived DeviceFeature flags (e.g. `lock-open`) — surfaced on the
   *  child's `device.features` so the UI gates feature affordances. */
  features: z.array(z.string()).optional(),
  /** HA friendly_name — persisted so the child device name survives
   *  a reboot without a discovery round-trip. Falls back to entityId. */
  name: z.string().optional(),
  /** Locale-render shape for a `DateTimeSensor`-role enum sensor
   *  (`device_class=timestamp` → `'datetime'`, `date` → `'date'`). Seeded into
   *  the enum-sensor cap slice by the child so the UI renders the ISO `value`. */
  dateTimeFormat: EnumSensorDateTimeFormatSchema.optional(),
  /** HA `entity_category` — `config` / `diagnostic` / absent (a normal
   *  control). Drives the accordion section the child renders in. */
  entityCategory: z.enum(['config', 'diagnostic']).optional(),
})

const haContainerSchema = z.object({
  system: z.literal('homeassistant'),
  brokerId: z.string(),
  haDeviceId: z.string(),
  integrationId: z.string().optional(),
  entities: z.array(haEntitySchema).default([]),
})

type HaContainerEntity = z.infer<typeof haEntitySchema>

/**
 * A container entity is a battery source when the HA domain mapping
 * assigned it the `BatterySensor` role, or — defensively — when its
 * raw HA `device_class` is `battery`. Either signal is reliable: the
 * role is the post-mapping marker the adoption flow persists, and the
 * device_class is the original HA attribute that drove it.
 */
function isBatteryEntity(entity: HaContainerEntity): boolean {
  return entity.role === DeviceRole.BatterySensor || entity.deviceClass === 'battery'
}

/**
 * A battery entity is BINARY when HA exposes it as a `binary_sensor`
 * (device_class `battery`) rather than a numeric `sensor`. The HA domain
 * mapping marks those with the `binary` capability. A binary battery reports
 * only `LOW_BAT` (`on` = low / needs replacement, `off` = normal) — there is
 * NO real percentage. (e.g. HomeMatic `HmIP-DLD` locks.)
 */
function isBinaryBattery(entity: HaContainerEntity): boolean {
  return entity.capabilities.includes('binary') && !entity.capabilities.includes('numeric-sensor')
}

/**
 * Pick the best battery entity for the device-level `battery` cap. Prefer a
 * NUMERIC battery sensor (a real 0–100 %) over a binary `LOW_BAT` indicator
 * when a device exposes both, so the badge shows the true charge where HA has
 * it.
 */
function selectBatteryEntity(entities: readonly HaContainerEntity[]): HaContainerEntity | null {
  const batteries = entities.filter(isBatteryEntity)
  return batteries.find((e) => !isBinaryBattery(e)) ?? batteries[0] ?? null
}

/** Percentages for a BINARY (`LOW_BAT`) battery: normal reads full, low reads
 *  below the conventional 20 % warning band so consumers' low-battery alerting
 *  fires — but not 0 % (the cell isn't dead, it just needs replacing). */
const BINARY_BATTERY_NORMAL_PCT = 100
const BINARY_BATTERY_LOW_PCT = 15

/**
 * Derive the container's device-level `battery` status from ONE of its
 * entities' live HA state. Returns null when the physical device has no
 * battery entity, or when the state does not parse as a reading.
 *
 * This used to be four auto-authored `DeviceLink`s, persisted on the container
 * and resolved by the kernel's link overlay — a provider deriving one of its
 * own fields through a mechanism that let ANY operator write it. Wiring was
 * deleted on 2026-08-08 (0 links across 302 devices; this container had no
 * `battery` binding live either) and the derivation came home: the container
 * computes the slice and owns the cap, which is one authority instead of two.
 *
 * - NUMERIC battery sensor (real 0–100 %): the state parsed as a number and
 *   CLAMPED to [0,100] — an out-of-range firmware value must never fail the
 *   whole status, which is exactly what the `linear … clamp [0,100]` transform
 *   bought before.
 * - BINARY `LOW_BAT` indicator: `on` (low) → 15 %, `off` (normal) → 100 %, plus
 *   `binary: true` so the UI renders "Normal"/"Low" instead of a misleading
 *   exact percentage.
 * - Numeric is preferred over binary when a device exposes both
 *   (`selectBatteryEntity`).
 */
export function deriveBatteryStatus(
  entities: readonly HaContainerEntity[],
  entityId: string,
  state: HaEntityState,
  now: number,
): BatteryStatus | null {
  const battery = selectBatteryEntity(entities)
  if (!battery || battery.entityId !== entityId) return null
  if (isBinaryBattery(battery)) {
    if (state.state !== 'on' && state.state !== 'off') return null
    return {
      percentage: state.state === 'on' ? BINARY_BATTERY_LOW_PCT : BINARY_BATTERY_NORMAL_PCT,
      charging: 'none',
      sleeping: false,
      lastUpdated: now,
      binary: true,
    }
  }
  const raw = Number(state.state)
  if (!Number.isFinite(raw)) return null
  return {
    percentage: Math.min(100, Math.max(0, raw)),
    charging: 'none',
    sleeping: false,
    lastUpdated: now,
  }
}

/** Which entity, if any, feeds the container's `battery` cap. */
export function batteryEntityId(entities: readonly HaContainerEntity[]): string | null {
  return selectBatteryEntity(entities)?.entityId ?? null
}

/**
 * Parent container device for a single HA physical device. Owns no
 * control caps itself — its only job is to declare `getAccessoryChildren()`
 * so the kernel auto-spawns one accessory child per HA entity and
 * reconciles additions/removals across reboots.
 *
 * Config shape (persisted in the device blob):
 *   system:        'homeassistant'  (literal, schema discriminator)
 *   brokerId:      the HA broker/integration id
 *   haDeviceId:    HA device registry id (used by adopt / restore)
 *   integrationId: optional CamStack integration id (stamped on children)
 *   entities:      one entry per HA entity linked to this physical device
 *
 * The kernel handles the full lifecycle for each child: allocate id,
 * persist initial config, build context, construct via factory, then
 * run the child's own probe + accessory + activate phases.
 */
export class HaContainerDevice extends BaseDevice<typeof haContainerSchema> {
  // The container is the on-demand re-sync target — children carry no
  // haDeviceId, so the re-sync (re-align type / role / caps / units with the
  // HA mapping) is offered only on the parent. Advertising `Resyncable` drives
  // the generic Re-sync button in the admin UI; the action is served by the
  // `device-adoption.resync` cap. `BatteryOperated` is appended when the
  // physical device carries a battery entity (see constructor) so device
  // profiles / battery affordances gate on the container itself.
  readonly features: readonly DeviceFeature[]

  private readonly brokerId: string
  private readonly integrationId: string | undefined

  /** Set of this device's entity ids (the physical HA device's entities). The
   *  container's `online` is derived as "any of these entities reachable" (A3). */
  private readonly entityIds: ReadonlySet<string>

  /** Per-entity reachability, folded from `broker.message` availability pushes.
   *  `online` is recomputed as `any value === true`. */
  private readonly entityReachable = new Map<string, boolean>()

  /** Disposer for the cap event-bus listener that derives `online` from the
   *  availability of every child entity. */
  private availabilityEventUnsub: (() => void) | null = null

  /** Upstream broker subscription id for the all-entities availability feed —
   *  released in `removeDevice`. Null until `onActivate` subscribes. */
  private availabilitySubscriptionId: string | null = null

  /** EventCategory the cap event bus uses for HA push notifications. */
  private static readonly BROKER_MSG_CATEGORY = 'broker.message'

  constructor(ctx: DeviceContext) {
    // Parse cfg BEFORE super() — allowed because we don't reference `this`.
    const cfg = haContainerSchema.parse(ctx.persistedConfig ?? {})
    const batteryEntity = selectBatteryEntity(cfg.entities)
    super(ctx, haContainerSchema, { type: DeviceType.Container })
    this.brokerId = cfg.brokerId
    this.integrationId = cfg.integrationId
    this.features =
      batteryEntity !== null
        ? [DeviceFeature.Resyncable, DeviceFeature.BatteryOperated]
        : [DeviceFeature.Resyncable]
    this.entityIds = new Set(cfg.entities.map((e) => e.entityId))
    // `online` is NOT hardcoded true (A3): it derives from the children's live
    // availability. It starts false and the first reachable entity push flips it
    // true; a broker disconnect (A2) marks every child — and this container —
    // offline. The availability listener + subscription are wired in onActivate
    // (post-registration).
    this.online = false
    // The device-level `battery` cap is NATIVE on the container when — and only
    // when — the physical device actually carries a battery entity. Its slice
    // is derived in `attachAvailabilityListener` from the same `broker.message`
    // push stream that already drives `online`, so there is no second
    // subscription and no second decode path.
    this.batteryEntityId = batteryEntityId(cfg.entities)
    if (this.batteryEntityId !== null) {
      // Cold seed: no reading has ever been taken. UNKNOWN, never 0 % (D393,
      // D315) — a dead cell and "we haven't asked yet" must never look alike.
      const COLD: BatteryStatus = {
        percentage: null,
        charging: 'unknown',
        sleeping: false,
        lastUpdated: 0,
      }
      const provider: InferNativeProvider<typeof batteryCapability> = {
        getStatus: async () => this.runtimeState.getCapState<BatteryStatus>('battery') ?? COLD,
        // An HA entity is read-only upstream — there is no wake path.
        wakeForStream: async () => ({ awoke: true, durationMs: 0 }),
      }
      this.ctx.registerNativeCap(batteryCapability, provider)
      // Seed ONLY a device with no REAL observation: `battery` is
      // `durability: 'restored'`, and `fromInitial` already hydrated the last
      // observation from storage. Writing COLD over a genuine reading
      // unconditionally turned a known 40 % into "unknown" on every restart
      // (D49) — so a slice is left alone UNLESS it is missing, or it is
      // itself the legacy cold seed this fix replaces.
      //
      // `lastUpdated === 0` is the reliable signature of "never observed":
      // every real reading stamps `now` (`deriveBatteryStatus`), so a
      // persisted `{ percentage: 0, charging: 'none', lastUpdated: 0 }` from
      // before this fix can only be the OLD fabricated seed, never a
      // genuine 0 % — re-seeding it destroys no observation and migrates the
      // legacy value forward (D663).
      const existing = this.runtimeState.getCapState<BatteryStatus>('battery')
      if (existing === undefined || existing.lastUpdated === 0) {
        this.runtimeState.setCapState('battery', COLD)
      }
    }
  }

  /** The entity whose state feeds the container's `battery` cap, or null when
   *  the physical device has none. */
  private readonly batteryEntityId: string | null

  /**
   * Subscribe to `broker.message` events for every one of this device's
   * entities and derive the container's `online` from their aggregate
   * availability (A3): `online = any entity reachable`. A child entity is
   * reachable when its HA state is anything other than `unavailable` /
   * `unknown` — the same chokepoint the per-child base uses for its own
   * `device.online`. When the broker drops, the integration manager fans
   * `markOnline(false)` to every child AND this container (A2); the next
   * reachable push here flips the container back online on reconnect.
   */
  private attachAvailabilityListener(): void {
    const handler = (event: { data: unknown }): void => {
      const data = event.data as { brokerId?: string; key?: string; payload?: unknown } | undefined
      if (!data) return
      if (data.brokerId !== this.brokerId) return
      if (typeof data.key !== 'string' || !this.entityIds.has(data.key)) return
      const state = data.payload as HaEntityState | undefined
      if (!state) return
      const reachable = state.state !== 'unavailable' && state.state !== 'unknown'
      this.entityReachable.set(data.key, reachable)
      this.recomputeOnline()
      if (data.key !== this.batteryEntityId) return
      const battery = deriveBatteryStatus(this.config.values.entities, data.key, state, Date.now())
      if (battery !== null) this.runtimeState.setCapState('battery', battery)
    }
    const unsub = this.ctx.eventBus.subscribe(
      { category: HaContainerDevice.BROKER_MSG_CATEGORY },
      handler,
    )
    this.availabilityEventUnsub = typeof unsub === 'function' ? unsub : null
  }

  /** Recompute `online` as "any child entity currently reachable". `markOnline`
   *  no-ops when the value is unchanged, so this is churn-free. */
  private recomputeOnline(): void {
    let anyReachable = false
    for (const reachable of this.entityReachable.values()) {
      if (reachable) {
        anyReachable = true
        break
      }
    }
    if (this.online !== anyReachable) {
      this.ctx.logger.info('ha-container online transition (derived from children)', {
        meta: { online: anyReachable, entityCount: this.entityIds.size },
      })
      this.markOnline(anyReachable)
    }
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // device-admin-link — a container IS an HA device-registry entry, so it
    // gets the real device configuration page rather than an entity view.
    registerHaAdminLink(this.ctx, this.id, this.brokerId, {
      kind: 'device',
      haDeviceId: this.config.values.haDeviceId,
    })
    // Availability-derived online (A3): attach the listener, then subscribe to
    // every entity so the integration manager's immediate cache-replay seeds
    // the per-entity reachability map (and thus `online`) at activation.
    if (this.entityIds.size > 0) {
      this.attachAvailabilityListener()
      try {
        const result = await this.ctx.api.broker.subscribe.mutate({
          brokerId: this.brokerId,
          filter: { entityIds: [...this.entityIds] },
        })
        this.availabilitySubscriptionId = result.subscriptionId
      } catch (err) {
        this.ctx.logger.warn('ha-container failed to subscribe entities for availability', {
          meta: { brokerId: this.brokerId, error: errMsg(err) },
        })
      }
    }
    // Group the auto-spawned children into HA-nomenclature accordion sections
    // (Controls / Configuration / Diagnostic). Best-effort: a layout failure
    // never blocks activation. Re-derived on every reconcile too, so an
    // entity_category change in HA re-sections automatically.
    await this.persistChildLayout()
  }

  override async removeDevice(): Promise<void> {
    if (this.availabilityEventUnsub) {
      try {
        this.availabilityEventUnsub()
      } catch {
        // best-effort
      }
      this.availabilityEventUnsub = null
    }
    if (this.availabilitySubscriptionId !== null) {
      try {
        await this.ctx.api.broker.unsubscribe.mutate({
          brokerId: this.brokerId,
          subscriptionId: this.availabilitySubscriptionId,
        })
      } catch {
        // best-effort — device is being torn down regardless
      }
      this.availabilitySubscriptionId = null
    }
  }

  /**
   * Derive this container's `childLayout` from its LIVE entities and persist it
   * via `deviceManager.setChildLayout`, grouping the auto-spawned children into
   * HA-nomenclature accordion sections (Controls / Configuration / Diagnostic).
   * Idempotent + best-effort: a failure is logged and swallowed so it
   * never breaks activation or reconcile. Reads the LIVE config so a re-sync that
   * updated `entities[]` re-sections on the next call.
   */
  async persistChildLayout(): Promise<void> {
    try {
      const childLayout = deriveChildLayout(this.config.values.entities)
      await this.ctx.api.deviceManager.setChildLayout.mutate({ deviceId: this.id, childLayout })
    } catch (err) {
      this.ctx.logger.warn('ha-container failed to persist childLayout', {
        meta: { haDeviceId: this.config.values.haDeviceId, error: errMsg(err) },
      })
    }
  }

  /**
   * Device-level RAW upstream state for the physical HA device. HA has no
   * single device-level state blob — a device's truth lives in its entities —
   * so we aggregate every linked entity's raw `{ state, attributes }` (the
   * attributes carry the device-level facts: model, manufacturer/interface,
   * supported_features, device_class, …). Surfaced via `device-ops.getRawState`
   * as the Raw section on the container's State panel. One-shot, reads the
   * integration manager's cache (no upstream round-trip).
   */
  async getRawState(): Promise<RawStateResult | null> {
    const entities: Record<string, { state: string; attributes: Record<string, unknown> }> = {}
    for (const e of this.config.values.entities) {
      try {
        const cached = await this.ctx.api.broker.getState.query({
          brokerId: this.brokerId,
          key: e.entityId,
        })
        const parsed = HaEntityStateSchema.safeParse(cached)
        if (parsed.success) {
          entities[e.entityId] = { state: parsed.data.state, attributes: parsed.data.attributes }
        }
      } catch {
        // skip entities whose state can't be read — partial raw is still useful
      }
    }
    return {
      source: 'homeassistant',
      data: { haDeviceId: this.config.values.haDeviceId, entities },
    }
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    // Read entities from the LIVE config (not a constructor-frozen copy) so a
    // re-sync that persists updated `entities[]` via `config.setAll` is reflected
    // on the next reprobe — driving spawn of new children + orphan removal.
    return this.config.values.entities.map((e) => {
      const entityId = e.entityId
      const brokerId = this.brokerId
      const integrationId = this.integrationId
      const capabilities = e.capabilities

      const meta: AccessoryChildSpec['meta'] = {
        type: e.deviceType,
        name: e.name ?? entityId,
        ...(integrationId !== undefined ? { integrationId } : {}),
        ...(e.role !== undefined ? { role: e.role } : {}),
      }

      const config: Record<string, unknown> = {
        brokerId,
        entityId,
        capabilities,
        ...(e.unitOfMeasurement !== undefined ? { unitOfMeasurement: e.unitOfMeasurement } : {}),
        ...(e.deviceClass !== undefined ? { deviceClass: e.deviceClass } : {}),
        ...(e.options !== undefined ? { options: e.options } : {}),
        ...(e.features !== undefined ? { features: e.features } : {}),
        ...(e.dateTimeFormat !== undefined ? { dateTimeFormat: e.dateTimeFormat } : {}),
        ...(e.role !== undefined ? { role: e.role } : {}),
      }

      // Derive the concrete class from the CHILD's own config rather than the
      // closed-over (adoption-time) capabilities, so a generic re-sync that
      // persists updated capabilities and rebuilds the child via this same
      // factory yields the new class. Falls back to the spec capabilities on
      // first spawn / when config carries none yet — AND when the persisted
      // capabilities no longer resolve to a class (a cap retired across an
      // upgrade, e.g. the HA camera→image migration, where a prior reconcile
      // updated `entities[]` but not yet the child config). Without this
      // fallback such a child fails to spawn entirely and registers no caps.
      const factory = (childCtx: DeviceContext): IDevice => {
        const liveCaps = childCtx.persistedConfig?.['capabilities']
        const persistedCaps =
          Array.isArray(liveCaps) && liveCaps.every((c): c is string => typeof c === 'string')
            ? liveCaps
            : null
        const ChildClass =
          (persistedCaps !== null ? tryPickHaChildClass(persistedCaps) : null) ??
          // Spec caps from the container's live `entities[]` — the authoritative
          // reconcile-updated source. `pickHaChildClass` throws its descriptive
          // error here if even these don't resolve (a genuine mapping gap).
          pickHaChildClass(capabilities)
        return new ChildClass(childCtx)
      }

      return { stableIdSuffix: entityId, meta, config, factory } satisfies AccessoryChildSpec
    })
  }
}
