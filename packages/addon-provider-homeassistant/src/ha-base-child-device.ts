import { registerHaAdminLink } from './ha-admin-link.js'
import { z } from 'zod'
import {
  BaseDevice,
  errMsg,
  DeviceFeature,
  type DeviceContext,
  type DeviceRole,
  type IScopedLogger,
  type RawStateResult,
} from '@camstack/types'
import { haSourceSchemaFields } from './ha-device-source.js'
import { attachAccessoriesCap, type AccessoriesCapHandle } from './ha-accessories-cap.js'
import { HaEntityStateSchema, type HaEntityState } from './ha-types.js'
import type { HaStatePushContext } from './ha-change-stamp.js'

/**
 * Persisted config shared by every per-domain HA child device class.
 * Extends `haSourceSchemaFields` so the same persistence row migrates
 * forward when an adoption record is replayed under a proper subclass,
 * and carries `childDeviceIds` so parent-mode devices can host the
 * accessories cap for their entity-children.
 */
export const haChildDeviceSchema = z.object({ ...haSourceSchemaFields })

export type HaChildDeviceConfig = z.infer<typeof haChildDeviceSchema>

/**
 * Abstract base for every HA-entity-backed CamStack accessory device.
 *
 * Owns the wiring that's identical across every domain:
 *   - subscribes to the typed event-bus on `broker.message` events
 *     and filters to the device's own (brokerId, entityId) tuple
 *   - on every matching push, invokes `handleStatePush(state)` —
 *     subclasses override with the cap-slice translator that writes
 *     the new state into the per-cap runtime-state slice
 *   - exposes `callHaService(serviceName, data?)` so cap method
 *     implementations route uniformly through the `broker` cap's
 *     `publish` surface (one WS per integration, regardless of how
 *     many child devices issue service calls concurrently)
 *
 * Phase F: concrete subclasses (HaSwitchDevice, HaNumericSensorDevice,
 * HaBinarySensorDevice, …) carry the per-domain decoders + cap
 * provider registration. The base class never registers a cap on its
 * own (beyond BaseDevice's auto-registered `device-status` /
 * `feature-probe`).
 */
const DEVICE_FEATURE_VALUES = new Set<string>(Object.values(DeviceFeature))

/** Keep only strings that are valid DeviceFeature enum values (the persisted
 *  config stores them as plain strings). */
function parseDeviceFeatures(raw: unknown): readonly DeviceFeature[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (f): f is DeviceFeature => typeof f === 'string' && DEVICE_FEATURE_VALUES.has(f),
  )
}

export abstract class HaBaseChildDevice extends BaseDevice<typeof haChildDeviceSchema> {
  /** Mapping-derived feature flags (e.g. `lock-open`), read from the persisted
   *  config at construction. Surfaced on `device.features` (and re-published to
   *  the device meta in `onActivate` via `refreshFeatures`) so the UI gates
   *  feature affordances like the lock "Open door" button. */
  readonly features: readonly DeviceFeature[]

  protected readonly brokerId: string
  protected readonly entityId: string

  /** Logger pre-bound with the device-scoping hierarchy
   *  (addon → integrationId → containerDeviceId → deviceId) so every log this
   *  child emits — HA websocket state pushes AND camstack-side cap calls — is
   *  filterable by device. */
  protected readonly deviceLogger: IScopedLogger

  /** Last HA `state` string we logged a value-change for — lets the per-push
   *  log report `old → new` and skip churn-free repeats. */
  private lastLoggedState: string | null = null

  /** EventCategory the cap event bus uses for HA push notifications. */
  private static readonly BROKER_MSG_CATEGORY = 'broker.message'

  /** Disposer returned by the event-bus subscribe call — invoked from
   *  `removeDevice` to stop the handler before the device is dropped
   *  from the kernel. */
  private eventBusUnsub: (() => void) | null = null

  /** Upstream broker subscription id — registered so the integration
   *  manager fans state-changed pushes out as `broker.message` events
   *  for this device's entity. Released in `removeDevice`. */
  private brokerSubscriptionId: string | null = null

  /** Handle to the accessories cap when this device acts as a parent
   *  that hosts entity-children. Null for plain child devices. */
  private accessories: AccessoriesCapHandle | null = null

  constructor(ctx: DeviceContext, options: { role?: DeviceRole } = {}) {
    const persisted = (ctx.persistedConfig ?? {}) as HaChildDeviceConfig
    const brokerId = persisted.brokerId
    const entityId = persisted.entityId
    if (typeof brokerId !== 'string' || brokerId.length === 0) {
      throw new Error(`HaBaseChildDevice: missing brokerId in persisted config (id=${ctx.id})`)
    }
    if (typeof entityId !== 'string' || entityId.length === 0) {
      throw new Error(`HaBaseChildDevice: missing entityId in persisted config (id=${ctx.id})`)
    }
    super(ctx, haChildDeviceSchema, {
      type: ctx.deviceMeta.type,
      ...(options.role !== undefined ? { role: options.role } : {}),
    })
    this.brokerId = brokerId
    this.entityId = entityId
    this.features = parseDeviceFeatures(persisted.features)
    // Fall back to the base logger when `withTags` isn't available (defensive —
    // real IScopedLogger always supports it).
    // `deviceId` + `containerDeviceId` are already stamped on the base
    // `ctx.logger` by the kernel (device-cap-proxy) from the device hierarchy;
    // here we only layer the HA `integrationId` on top.
    this.deviceLogger =
      ctx.deviceMeta.integrationId !== undefined
        ? (ctx.logger.withTags({ integrationId: ctx.deviceMeta.integrationId }) ?? ctx.logger)
        : ctx.logger
    this.online = true
    this.attachEventBusListener()
    const childIds = Array.isArray(persisted.childDeviceIds) ? persisted.childDeviceIds : []
    if (childIds.length > 0) {
      this.accessories = attachAccessoriesCap(this.ctx, this.id, { initialHidden: [] })
      this.accessories.setChildren(childIds)
    }
    // sourceInfo = identity only (dispatch key + system tag).
    // Rendering metadata (unit, precision) flows live via the cap slice on
    // each state push. device_class was only ever an input to ha-domain-mapping
    // and is not stored here.
    void this.updateSourceInfo({
      id: this.entityId,
      system: 'homeassistant',
    })
  }

  /** Parent-mode: update the hosted accessory-children list. Lazily attaches
   *  the accessories cap if not yet present. No-op semantics for plain children
   *  that never call this. */
  setAccessoryChildren(ids: readonly number[]): void {
    if (!this.accessories)
      this.accessories = attachAccessoriesCap(this.ctx, this.id, { initialHidden: [] })
    this.accessories.setChildren(ids)
  }

  /**
   * Phase 5 — fires after the device + all its accessories are registered
   * and every subclass constructor has fully run (so `registerNativeCap`
   * calls and class-field assignments in concrete subclasses have all
   * completed before this executes).
   *
   * We subscribe to the broker here rather than in the constructor so the
   * integration-manager's immediate cache-replay lands AFTER every
   * subclass cap schema is installed via `registerNativeCap`. Without
   * this ordering, `handleStatePush` → `setCapState` fires while the
   * cap schema is still unregistered → "[DeviceRuntimeState] no schema
   * registered for cap …" error.
   *
   * `attachEventBusListener()` remains in the constructor: the event-bus
   * handler must exist before the replay fires, and now the replay only
   * arrives at onActivate time — well after the handler is attached.
   */
  override async onActivate(): Promise<void> {
    await super.onActivate()
    // device-admin-link — a child / standalone device IS one HA entity, so its
    // page is the entity's, not a device-registry page. Registered here, once,
    // for every per-domain subclass: they all reach HA through the same entity.
    registerHaAdminLink(this.ctx, this.id, this.brokerId, {
      kind: 'entity',
      entityId: this.entityId,
    })
    // Publish the mapping-derived features to the persisted device meta so the
    // hub registry + UI see them (the construction-time snapshot registered by
    // the kernel may predate the features being threaded through). Best-effort.
    await this.refreshFeatures()
    const subscribed = await this.subscribeBrokerEntity()
    // Lifecycle marker: one line per entity, so even a quiet device has a
    // baseline entry in its own Logs tab.
    //
    // **"ready" is only logged when the entity IS ready.** It used to be
    // unconditional, so a failed subscription was immediately followed by
    // `HA entity ready` — and on 2026-08-05 fourteen doorbell entities read as
    // healthy while not one of them could receive a state change. An operator
    // scanning for "ready" saw success on a device that was functionally dead.
    if (subscribed) {
      this.deviceLogger.info('HA entity ready', {
        meta: {
          entityId: this.entityId,
          type: this.ctx.deviceMeta.type,
          ...(this.features.length > 0 ? { features: [...this.features] } : {}),
        },
      })
      return
    }
    this.deviceLogger.warn('HA entity registered but NOT subscribed — it will receive nothing', {
      meta: {
        entityId: this.entityId,
        brokerId: this.brokerId,
        type: this.ctx.deviceMeta.type,
      },
    })
  }

  override async removeDevice(): Promise<void> {
    if (this.eventBusUnsub) {
      try {
        this.eventBusUnsub()
      } catch {
        // best-effort
      }
      this.eventBusUnsub = null
    }
    if (this.brokerSubscriptionId !== null) {
      try {
        await this.ctx.api.broker.unsubscribe.mutate({
          brokerId: this.brokerId,
          subscriptionId: this.brokerSubscriptionId,
        })
      } catch {
        // best-effort — device is being torn down regardless
      }
      this.brokerSubscriptionId = null
    }
  }

  /**
   * Opt-in raw-state surface (`device-ops.getRawState`). Returns the
   * entity's cached upstream `HaEntityState` as `{ source, data }`, read
   * from the broker's in-memory cache via `broker.getState` (no upstream
   * round-trip — the registry's `getState` reads the local snapshot).
   * Returns `null` when the entity has never published / is unknown.
   *
   * HA `attributes` are display-safe (no secrets/PII), so the blob is
   * forwarded verbatim — no redaction needed.
   */
  async getRawState(): Promise<RawStateResult | null> {
    let cached: unknown
    try {
      cached = await this.ctx.api.broker.getState.query({
        brokerId: this.brokerId,
        key: this.entityId,
      })
    } catch (err) {
      this.deviceLogger.warn('ha-child getRawState failed to read cached state', {
        meta: { brokerId: this.brokerId, entityId: this.entityId, error: errMsg(err) },
      })
      return null
    }
    const parsed = HaEntityStateSchema.safeParse(cached)
    if (!parsed.success) return null
    const entity = parsed.data
    return {
      source: 'homeassistant',
      data: { state: entity.state, attributes: entity.attributes },
    }
  }

  // ── Subclass hooks ───────────────────────────────────────────────────

  /**
   * Override to decode `state` (HA entity state envelope) into the
   * device's cap-state slice and persist via `this.runtimeState`.
   * Called on every WS push matching this entity. Default: no-op.
   */
  protected handleStatePush(_state: HaEntityState, _push: HaStatePushContext): void {
    // no-op — subclasses override
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Issue an HA service call for this device's entity. The target's
   * entity_id is pinned to `this.entityId` automatically. Returns the
   * service-call result (HA's `return_response` payload) when present,
   * or null.
   */
  protected async callHaService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
  ): Promise<unknown> {
    // Outbound update (camstack → HA): one log per command we issue.
    this.deviceLogger.info('device→HA service call', {
      meta: { domain, service, entityId: this.entityId, ...(data !== undefined ? { data } : {}) },
    })
    try {
      return await this.ctx.api.broker.publish.mutate({
        brokerId: this.brokerId,
        target: { domain, service, entityId: this.entityId },
        ...(data !== undefined ? { payload: data } : {}),
      })
    } catch (err) {
      this.deviceLogger.warn('ha-child callHaService failed', {
        meta: {
          brokerId: this.brokerId,
          entityId: this.entityId,
          domain,
          service,
          error: errMsg(err),
        },
      })
      throw err
    }
  }

  // ── Private ──────────────────────────────────────────────────────────

  /**
   * Register an upstream broker subscription for this device's entity so
   * the integration manager fans `state_changed` pushes — and the current
   * cache snapshot — out as `broker.message` events. Must be called AFTER
   * `attachEventBusListener()` so the immediate cache-replay lands in the
   * already-attached handler and `handleStatePush` fires with the real
   * current state (seeding the cap-state slice at construction time).
   */
  /** True when the entity is genuinely subscribed. The caller uses it to
   *  decide whether "ready" is an honest thing to log. */
  private async subscribeBrokerEntity(): Promise<boolean> {
    try {
      const result = await this.ctx.api.broker.subscribe.mutate({
        brokerId: this.brokerId,
        filter: { entityIds: [this.entityId] },
      })
      this.brokerSubscriptionId = result.subscriptionId
      return true
    } catch (err) {
      this.deviceLogger.warn('ha-child failed to register broker subscription', {
        meta: { entityId: this.entityId, brokerId: this.brokerId, error: errMsg(err) },
      })
      return false
    }
  }

  private attachEventBusListener(): void {
    const eb = this.ctx.eventBus
    const handler = (event: { data: unknown }): void => {
      const data = event.data as
        | {
            brokerId?: string
            key?: string
            payload?: unknown
          }
        | undefined
      if (!data) return
      if (data.brokerId !== this.brokerId) return
      if (data.key !== this.entityId) return
      // The payload is the HaEntityState snapshot (the integration
      // manager pre-folds it via processEvent before emitting).
      const state = data.payload as HaEntityState | undefined
      if (!state) return
      // Inbound update (HA → camstack): a value change is operational churn,
      // so it logs at DEBUG (lifecycle events below stay INFO). Reports the
      // `old → new` transition and skips churn-free repeats of the same value.
      if (state.state !== this.lastLoggedState) {
        this.deviceLogger.debug('HA→device value change', {
          meta: {
            entityId: this.entityId,
            from: this.lastLoggedState ?? undefined,
            to: state.state,
          },
        })
        this.lastLoggedState = state.state
      }
      // Entity availability → device.online (base chokepoint, A1). HA reports
      // an unreachable entity as `unavailable` / `unknown`. The base owns the
      // `device-status` slice for ALL domains here; subclasses keep their own
      // `unavailable`/`unknown` early-returns so the last-known VALUE slice is
      // preserved. `markOnline` no-ops when unchanged, so this is churn-free.
      const reachable = state.state !== 'unavailable' && state.state !== 'unknown'
      // Read BEFORE the liveness flips: this push ENDS an outage this process saw.
      const push: HaStatePushContext = { afterOutage: reachable && !this.online }
      if (this.online !== reachable) {
        // One line per liveness transition (not per push) — operationally
        // useful and churn-free since markOnline already no-ops when unchanged.
        this.deviceLogger.info('HA→device online transition', {
          meta: { entityId: this.entityId, online: reachable, state: state.state },
        })
        this.markOnline(reachable)
      }
      try {
        this.handleStatePush(state, push)
      } catch (err) {
        this.deviceLogger.warn('ha-child state-push handler error', {
          meta: { entityId: this.entityId, error: errMsg(err) },
        })
      }
    }
    const unsub = eb.subscribe({ category: HaBaseChildDevice.BROKER_MSG_CATEGORY }, handler)
    this.eventBusUnsub = typeof unsub === 'function' ? unsub : null
  }
}
