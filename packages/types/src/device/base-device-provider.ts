import { BaseAddon } from '../addon/base-addon.js'
import {
  type DiscoveryHit,
  type DiscoveryMode,
  deviceProviderCapability,
} from '../capabilities/device-provider.cap.js'
import type { AddonInitResult, ProviderRegistration } from '../interfaces/addon.js'
import type { ConfigUISchema } from '../interfaces/config-ui.js'
import type { IDevice } from './device.js'
import type { DeviceConstructor } from './device-context.js'
import type { CreateDeviceSpec, SavedDevice } from './device-management.js'
import type { InitialRestoreFailure, PermanentRestoreFailure } from './device-restore-retry.js'
import {
  DEVICE_RESTORE_RETRY_CONCURRENCY,
  DEVICE_RESTORE_RETRY_DELAYS_MS,
  DeviceRestoreRetryScheduler,
} from './device-restore-retry.js'
import { DeviceType } from './device-type.js'
import type { SourceInfo } from './source-info.js'

// ── Shared interfaces (previously duplicated in each provider) ──────

export interface DiscoveryCandidate {
  readonly stableId: string
  readonly type: DeviceType
  readonly suggestedName: string
  readonly prefilledConfig: Record<string, unknown>
  /** Optional upstream-system identity + rendering envelope. See
   *  `SourceInfo`. Pre-populated by providers whose discovery surface
   *  knows the upstream identity ahead of adoption (HA: entity_id +
   *  unit + device_class from `GET /api/states`). */
  readonly sourceInfo?: SourceInfo
  /** Set when the provider recognises this candidate as a device it ALREADY
   *  owns. A scan usually cannot reproduce the identity a device was onboarded
   *  under, so a stableId comparison never matches and an owned device looks
   *  addable — re-adopting it overwrites its config with scan-derived values.
   *  Absent means "not recognised", NOT "known to be new". */
  readonly alreadyOnboarded?: boolean
  /** Numeric id of the device this candidate was matched to. Set with `alreadyOnboarded`. */
  readonly onboardedDeviceId?: number
  /** Operator-facing name of the matched device, so the UI can say WHICH one it is. */
  readonly onboardedName?: string
  /** The candidate is an integration to set up, not a device to adopt. */
  readonly setupIntegration?: boolean
  /** `stableId` of the gateway candidate this device was found behind. */
  readonly parentStableId?: string
  /** `false` = shown for context, not pickable. Default true. */
  readonly selectable?: boolean
}

export interface DeviceSummary {
  readonly id: number
  readonly stableId: string
  readonly addonId: string
  readonly type: string
  readonly name: string
  readonly parentDeviceId: number | null
  readonly online: boolean
  readonly features: readonly string[]
  readonly config: Record<string, unknown>
  /** Optional upstream-system identity + rendering envelope. See
   *  `SourceInfo`. Present when the device has been persisted with a
   *  non-synthetic source identifier (HA entities, vendor MAC, …);
   *  omitted when the synthetic backfill is in effect. */
  readonly sourceInfo?: SourceInfo
}

export interface ProviderStatus {
  readonly connected: boolean
  readonly deviceCount: number
  readonly error?: string
  /** This provider writes no camera's `motion` slice (D696); see `device-provider.cap.ts`. */
  readonly motionSliceWriter?: 'orchestrator'
}

/**
 * Outcome of an `onRestoreDevices` pass. Optional for back-compat:
 * providers with custom overrides may keep returning `void` — they
 * just don't get the accurate summary log (or the bounded retry the
 * default implementation wires up, see D347).
 */
export interface DeviceRestoreReport {
  /** Rows registered during the initial pass. */
  readonly restoredCount: number
  /** Rows that failed the initial pass and were handed to the bounded
   *  background retry. */
  readonly failedCount: number
}

export interface FieldProbeResult {
  readonly status: 'ok' | 'error'
  readonly labels?: readonly string[]
  readonly error?: string
  /**
   * Optional values the provider suggests applying to other form fields
   * after a successful probe. The form-builder merges these into the
   * working snapshot ONLY for fields the operator hasn't filled yet,
   * never overwriting user input. Typical use: a host-probe that
   * autodetects the camera model and proposes it as the device `name`.
   */
  readonly suggestedValues?: Readonly<Record<string, unknown>>
}

// ── Utility ─────────────────────────────────────────────────────────

/**
 * Convert an IDevice to the flat DeviceSummary shape expected by the
 * device-provider cap router. Shared across all providers.
 */
export function toDeviceSummary(device: IDevice, addonId: string): DeviceSummary {
  const config: Record<string, unknown> = {}
  for (const entry of device.config.entries()) {
    config[entry.key] = entry.value
  }
  return {
    id: device.id,
    stableId: device.stableId,
    addonId,
    type: String(device.type),
    name: device.name,
    parentDeviceId: device.parentDeviceId,
    online: device.online,
    features: [...device.features],
    config,
    // BaseDevice always resolves sourceInfo (synthetic or persisted).
    // `IDevice` doesn't declare the field — providers that override
    // `IDevice` outside the BaseDevice hierarchy stay backwards-
    // compatible. Read through a structural check so non-BaseDevice
    // implementations don't blow up.
    sourceInfo: (device as { sourceInfo?: SourceInfo }).sourceInfo,
  }
}

// ── Base class ──────────────────────────────────────────────────────

/**
 * Base class for device-provider addons (rtsp, onvif).
 *
 * Provides default implementations for the common device-provider cap
 * methods (`start`, `stop`, `getStatus`, `getDevices`, `supportsDiscovery`,
 * `supportsManualCreation`, `toDeviceSummary`). Subclasses override the
 * methods that differ per provider.
 *
 * @example
 * ```ts
 * class RtspProvider extends BaseDeviceProvider {
 *   protected readonly addonId = 'provider-rtsp'
 *   protected readonly providerName = 'RTSP'
 *
 *   protected async onCreateDevice(input) { ... }
 *   protected async onGetCreationSchema(type) { ... }
 *   protected async onRestoreDevices(saved) { ... }
 * }
 * ```
 */
export abstract class BaseDeviceProvider<
  TConfig extends object = Record<string, unknown>,
> extends BaseAddon<TConfig> {
  /** Addon ID used in DeviceSummary. Must match package.json id. */
  protected abstract readonly addonId: string

  /** Human-readable provider name for log messages. */
  protected abstract readonly providerName: string

  // ── Lifecycle (BaseAddon hooks) ─────────────────────────────────────

  protected async onInitialize(): Promise<ProviderRegistration[] | AddonInitResult | void> {
    this.ctx.logger.info(`${this.providerName} Provider initialized`)
    return [{ capability: deviceProviderCapability, provider: this }]
  }

  /** Flatten `super.onInitialize()` whether it returned an array or an envelope. */
  protected providerRegistrationsFromSuper(
    result: ProviderRegistration[] | AddonInitResult | void,
  ): ProviderRegistration[] {
    if (Array.isArray(result)) return result
    if (result !== undefined && result.providers !== undefined) return [...result.providers]
    return []
  }

  protected async onShutdown(): Promise<void> {
    // Stop any pending restore retries FIRST — a retry `create()` landing
    // mid-teardown would register a device the decommission loop below
    // never saw. Cancelled entries are NOT marked permanently failed:
    // the next boot restores them from the persisted rows.
    this._restoreShuttingDown = true
    this.cancelRestoreRetries()
    // Decommission every device this provider owns BEFORE returning.
    // Mirrors what Moleculer SIGTERM + in-process restart paths
    // expect: each device's `removeDevice()` lifecycle hook fires
    // (closes alarm streams, ISAPI clients, polling timers, intercom
    // sessions, …), native caps unregister cleanly, registry entries
    // drop. The persisted device-meta / config rows stay intact so
    // the next boot's `restoreDevices` rehydrates the same set with
    // freshly-instantiated IDevice classes — that's the whole point
    // of "decommission, don't delete".
    //
    // Subclasses that need extra teardown (Moleculer service handle,
    // background workers) should override and call `super.onShutdown()`
    // first so devices are torn down before vendor-specific resources.
    const devices = (await this.ctx.kernel.devices?.getAll()) ?? []
    for (const device of devices) {
      try {
        await this.ctx.kernel.devices?.decommission(device.id)
      } catch (err) {
        this.ctx.logger.warn(`${this.providerName}: decommission failed`, {
          tags: { deviceId: device.id, stableId: device.stableId },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    this.ctx.logger.info(`${this.providerName} Provider shut down`, {
      meta: { decommissionedCount: devices.length },
    })
  }

  // ── device-provider cap — lifecycle + introspection ─────────────────
  // Default implementations. Override in subclass if needed.

  async start(): Promise<void> {
    /* no-op — providers are passive by default */
  }

  async stop(): Promise<void> {
    /* no-op */
  }

  async getStatus(): Promise<ProviderStatus> {
    const all = (await this.ctx.kernel.devices?.getAll()) ?? []
    // A permanently-unrestored device must be visible WITHOUT reading
    // logs (D347). `error` is the existing ProviderStatus surface the
    // admin UI already renders — no cap schema change needed.
    const summary = this.restoreFailureSummary()
    // `motionSliceWriter`: this provider writes no camera's `motion` slice — the
    // orchestrator does (D696). It is said HERE, in code every provider bundles,
    // so an older provider (which may still write it) can never say it.
    const base = {
      connected: true,
      deviceCount: all.length,
      motionSliceWriter: 'orchestrator',
    } as const
    if (summary === null) return base
    return { ...base, error: summary }
  }

  async getDevices(): Promise<ReadonlyArray<{ id: string; name: string; type: string }>> {
    const all = (await this.ctx.kernel.devices?.getAll()) ?? []
    return all.map((d) => ({
      id: d.stableId,
      name: d.name,
      type: String(d.type),
    }))
  }

  // ── device-provider cap — discovery ─────────────────────────────────
  // Default: no discovery. Override in providers that support it (ONVIF).

  async supportsDiscovery(): Promise<boolean> {
    return false
  }

  async discoverDevices(_input?: {
    params?: Record<string, unknown>
  }): Promise<readonly DiscoveryCandidate[]> {
    return []
  }

  /**
   * How the scan engine finds this provider. Default `[]`: the provider is
   * not migrated and keeps answering `discoverDevices` itself.
   */
  async getDiscoveryModes(): Promise<readonly DiscoveryMode[]> {
    return []
  }

  /** Turn the scan engine's raw hits into candidates. Default: none. */
  async classifyDiscoveryHits(_input: {
    hits: readonly DiscoveryHit[]
    params?: Record<string, unknown>
  }): Promise<readonly DiscoveryCandidate[]> {
    return []
  }

  /** Extra per-scan input form (e.g. a broadcast address for another subnet).
   *  Null = no extra params. Override in providers that support scoped scans. */
  async getDiscoveryParamsSchema(): Promise<ConfigUISchema | null> {
    return null
  }

  /**
   * The DeviceType this provider creates via manual add — derived from the
   * `deviceClasses` map (first registered type). `null` when manual creation is
   * unsupported. Lets the Add-Device dialog pick the right type per provider.
   */
  async getManualCreationType(): Promise<{ deviceType: DeviceType | null }> {
    if (!(await this.supportsManualCreation())) return { deviceType: null }
    const first = Object.values(DeviceType).find((t) => this.deviceClasses[t] !== undefined)
    return { deviceType: first ?? null }
  }

  async adoptDiscoveredDevice(_input: { candidate: DiscoveryCandidate }): Promise<DeviceSummary> {
    throw new Error(`${this.providerName} provider does not support discovery-based adoption`)
  }

  // ── device-provider cap — manual creation ───────────────────────────
  // Default: supports manual creation. Subclass must implement
  // onGetCreationSchema and onCreateDevice.

  async supportsManualCreation(): Promise<boolean> {
    return true
  }

  async getChildCreationSchema(input: { type: DeviceType }): Promise<ConfigUISchema | null> {
    return this.onGetCreationSchema(input.type)
  }

  /**
   * Default kernel-orchestrated `createDevice` implementation. The
   * subclass's `onCreateDevice` returns a declarative
   * `CreateDeviceSpec` (`{meta, config}`) — this method handles
   * stableId generation, class lookup, kernel.devices.create
   * dispatch, and DeviceSummary mapping. Subclasses should NOT
   * override this method; override `onCreateDevice` and
   * `deviceClasses` instead.
   */
  async createDevice(input: {
    type: DeviceType
    config: Record<string, unknown>
  }): Promise<DeviceSummary> {
    const spec = await this.onCreateDevice(input.type, input.config)
    const Class = this.deviceClasses[spec.meta.type] as DeviceConstructor<IDevice> | undefined
    if (!Class) {
      throw new Error(
        `${this.providerName} provider: no device class registered for type "${spec.meta.type}" — add it to the deviceClasses map`,
      )
    }
    const stableId = this.generateStableId(spec.meta.type, spec.config)
    const device = await this.ctx.kernel.devices!.create(
      stableId,
      Class,
      spec.config,
      null,
      spec.meta,
    )
    if (spec.onAfterCreate) {
      try {
        await spec.onAfterCreate(device)
      } catch (err) {
        this.ctx.logger.warn(
          'createDevice: onAfterCreate hook threw — device is already registered',
          {
            tags: { deviceId: device.id, stableId },
            meta: { error: err instanceof Error ? err.message : String(err) },
          },
        )
      }
    }
    return this.toSummary(device)
  }

  /**
   * Generate a stableId for a newly-created device. Default uses the
   * `${addonId}-${Date.now()}` pattern as a unique-but-opaque
   * fallback; any provider that has access to durable hardware
   * identity (UID, MAC, serial) should override and derive from it
   * so re-adding the same physical device reuses its persisted row.
   *
   * `config` is the parsed CreateDeviceSpec.config the subclass
   * returned from `onCreateDevice` — the override has access to
   * every operator-supplied + autodetect-resolved field. Optional
   * for back-compat: existing overrides that take only `type`
   * keep working unchanged.
   */
  protected generateStableId(_type: DeviceType, _config?: Record<string, unknown>): string {
    return `${this.addonId}-${Date.now()}`
  }

  async testCreationField(_input: {
    type: DeviceType
    key: string
    value: unknown
    formValues?: Record<string, unknown>
  }): Promise<FieldProbeResult> {
    return { status: 'ok', labels: ['probe not implemented'] }
  }

  // ── Boot restore ────────────────────────────────────────────────────

  async restoreDevices(savedDevices: readonly SavedDevice[]): Promise<void> {
    // A new restore pass is a new lifetime (an in-process restart reuses the
    // instance); a shutdown DURING this pass sets the flag again.
    this._restoreShuttingDown = false
    const report = await this.onRestoreDevices(savedDevices)
    if (savedDevices.length === 0) return
    if (report && report.failedCount > 0) {
      // Honest count: "Restored 33" while 5 timed out is how the
      // 2026-09-04 outage hid for 27 minutes.
      this.ctx.logger.warn(
        `Restored ${report.restoredCount}/${savedDevices.length} ${this.providerName} device(s) — ${report.failedCount} failed, bounded retry scheduled`,
      )
      return
    }
    const restoredCount = report ? report.restoredCount : savedDevices.length
    this.ctx.logger.info(`Restored ${restoredCount} ${this.providerName} device(s)`)
  }

  // ── Restore retry state (D347) ──────────────────────────────────────

  /** Retry schedule. Overridable (tests use millisecond delays). */
  protected readonly restoreRetryDelaysMs: readonly number[] = DEVICE_RESTORE_RETRY_DELAYS_MS

  /** Retry lane width. See `device-restore-retry.ts` for why retries
   *  never re-stampede full-width while the initial pass does (D167). */
  protected readonly restoreRetryConcurrency: number = DEVICE_RESTORE_RETRY_CONCURRENCY

  /** Every bounded retry this process started — the default pass's, and each
   *  `restoreWithBoundedRetry` of a provider's own rows. Cancelled together. */
  private _restoreRetrySchedulers: readonly DeviceRestoreRetryScheduler[] = []
  private _restoreRetryCompletion: Promise<void> | null = null
  /** Set by `onShutdown` BEFORE the retries are cancelled: a restore pass still
   *  in flight must not start a scheduler after the cancel ran. */
  private _restoreShuttingDown = false
  private readonly _permanentRestoreFailures = new Map<number, PermanentRestoreFailure>()

  /** Settles when the background retry rounds finish (or `null` when
   *  nothing failed). Exposed for tests and subclass diagnostics —
   *  boot NEVER awaits this: the runner's post-init handshake goes out
   *  with the devices that restored, and a late success is announced
   *  through the `native-cap-change` → `updateCaps` path. */
  protected get restoreRetryCompletion(): Promise<void> | null {
    return this._restoreRetryCompletion
  }

  /** Devices that exhausted the retry bound this process lifetime. */
  protected get permanentRestoreFailures(): readonly PermanentRestoreFailure[] {
    return [...this._permanentRestoreFailures.values()]
  }

  /** One-line operator-facing summary for `getStatus().error`, or
   *  `null` when every device restored. */
  protected restoreFailureSummary(): string | null {
    if (this._permanentRestoreFailures.size === 0) return null
    const ids = [...this._permanentRestoreFailures.keys()].join(', ')
    return `${this._permanentRestoreFailures.size} device(s) permanently failed restore (deviceIds: ${ids}) — restart the ${this.providerName} provider to retry`
  }

  /**
   * A top-level persisted row with NO configuration is a leftover, not a
   * device — quarantine it instead of dialling it.
   *
   * Device 105 was deleted, resurrected as a config-less shell by a write
   * already in flight (D376), and then dialled at every single boot: eight
   * `Failed to restore device — bounded retry scheduled` lines in one day,
   * each one the same Zod refusal on `host` and `password`. The bound was
   * real, but it is a bound PER PROCESS, and the runner restarts — so nothing
   * about the row ever stopped costing attempts and log lines.
   *
   * No retry can add a configuration that is not there. The row is reported
   * once, with its `deviceId`, and set aside.
   *
   * Top-level only: an accessory child legitimately carries an empty blob (it
   * lives off its parent), and a hub-adopted child with an emptied blob is
   * repaired by `healSavedConfig` from its parent instead. Providers that
   * genuinely create configuration-free top-level devices turn this off.
   */
  protected readonly quarantineConfiglessTopLevelRestores: boolean = true

  private isUnrestorableShell(saved: SavedDevice): boolean {
    if (!this.quarantineConfiglessTopLevelRestores) return false
    if (saved.parentDeviceId !== null) return false
    // `saved.config` is populated by both restore entry points (the worker's
    // `runWorkerDeviceRestoreWithRetry` and the hub's `restoreAddonDevices`
    // each read `deviceManager.loadConfig` per row). An UNDEFINED blob is a
    // caller that did not fetch it — unknown is not empty, and it must never
    // cost a device its restore.
    const config: Record<string, unknown> | undefined = saved.config
    if (config === undefined) return false
    return Object.keys(config).length === 0
  }

  private quarantineShell(saved: SavedDevice): void {
    this._permanentRestoreFailures.set(saved.id, {
      deviceId: saved.id,
      stableId: saved.stableId,
      type: saved.type,
      attempts: 0,
      lastError: 'persisted row has no configuration',
      failedAt: Date.now(),
    })
    this.ctx.logger.error(
      'Persisted device row has NO configuration — quarantined: not restored, not retried. Remove it (deviceManager.removeDevice) or re-add the device.',
      {
        tags: { deviceId: saved.id, stableId: saved.stableId },
        meta: { type: saved.type, provider: this.providerName },
      },
    )
  }

  private cancelRestoreRetries(): void {
    for (const scheduler of this._restoreRetrySchedulers) scheduler.cancel()
    this._restoreRetrySchedulers = []
  }

  private recordPermanentRestoreFailure(failure: PermanentRestoreFailure): void {
    this._permanentRestoreFailures.set(failure.deviceId, failure)
    this.ctx.logger.error(
      'Device restore permanently failed — its capabilities will not register until the provider restarts',
      {
        tags: { deviceId: failure.deviceId, stableId: failure.stableId },
        meta: {
          type: failure.type,
          attempts: failure.attempts,
          error: failure.lastError,
        },
      },
    )
  }

  private scheduleRestoreRetries(
    failures: readonly InitialRestoreFailure[],
    attempt: (saved: SavedDevice) => Promise<void>,
  ): void {
    if (this._restoreShuttingDown) {
      // The provider is shutting down: a scheduler started now would outlive
      // the cancel and re-dial devices the decommission never saw. The next
      // boot restores them from the persisted rows.
      this.ctx.logger.info('Restore retries not scheduled — the provider is shutting down', {
        meta: { rows: failures.length, deviceIds: failures.map((f) => f.saved.id) },
      })
      return
    }
    const scheduler = new DeviceRestoreRetryScheduler({
      logger: this.ctx.logger,
      delaysMs: this.restoreRetryDelaysMs,
      concurrency: this.restoreRetryConcurrency,
      attempt,
      onPermanentFailure: (failure) => this.recordPermanentRestoreFailure(failure),
    })
    this._restoreRetrySchedulers = [...this._restoreRetrySchedulers, scheduler]
    const run = scheduler
      .run(failures)
      .then((): void => undefined)
      .catch((err: unknown): void => {
        // `run()` is documented never to reject; this is belt-and-braces
        // so an unexpected throw can't become an unhandled rejection.
        this.ctx.logger.error('Restore retry scheduler crashed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    const prior = this._restoreRetryCompletion
    this._restoreRetryCompletion =
      prior === null ? run : Promise.all([prior, run]).then((): void => undefined)
  }

  /**
   * Restore rows the default pass does not handle (a provider's own restore
   * loop) under the SAME bounded retry (D347): one attempt each, in order; a
   * row that throws is logged with `tags.deviceId` and retried in the
   * background rounds, then marked permanently failed like any other.
   *
   * A restore is a device build, and a build whose runtime-state load did not
   * answer is REFUSED rather than started on cold defaults (D677) — so a
   * transient hub read must cost a retry, never the device until the next
   * runner restart. An ANSWERED `{}` is the device's true state and never
   * refuses.
   */
  protected async restoreWithBoundedRetry(
    rows: readonly SavedDevice[],
    attempt: (saved: SavedDevice) => Promise<void>,
  ): Promise<void> {
    const failures: InitialRestoreFailure[] = []
    for (const saved of rows) {
      // The D376 quarantine, as in the default pass: a config-less top-level
      // row is a leftover no retry can fix — reported once, never dialled.
      if (this.isUnrestorableShell(saved)) {
        this.quarantineShell(saved)
        continue
      }
      try {
        await attempt(saved)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        this.ctx.logger.warn('Failed to restore device — bounded retry scheduled', {
          tags: { deviceId: saved.id, stableId: saved.stableId },
          meta: { type: saved.type, attempt: 1, error },
        })
        failures.push({ saved, error })
      }
    }
    if (failures.length > 0) this.scheduleRestoreRetries(failures, attempt)
  }

  // ── In-place reload (device-provider cap) ───────────────────────────

  /**
   * Tear down and reconstruct ONE device from its persisted rows — the
   * `deviceProvider.reloadDevice` cap method. Persistence is never touched,
   * and no other device this provider owns is disturbed.
   *
   * Keyed by `stableId` because the caller's whole reason to be here is that
   * the NUMERIC id changed (`deviceManager.migrateDevice` swapped it): the
   * fresh instance resolves its id through `allocateDeviceId`, which returns
   * whatever number the row carries NOW. The teardown is `decommission` —
   * exactly what a graceful shutdown runs per device (fires `removeDevice()`,
   * unregisters native caps, drops the registry entry) — and the rebuild is
   * the boot restore's own `create()` path, including its pass 2: first-class
   * children (hub-adopted cameras under an NVR) are decommissioned with the
   * parent by the cascade and must be re-created explicitly, because only
   * accessory children come back through `getAccessoryChildren()`.
   *
   * Reloading an accessory child directly is refused (no device class) —
   * reload its parent instead.
   */
  async reloadDevice(input: { stableId: string }): Promise<{ deviceId: number }> {
    const { stableId } = input
    const devices = this.ctx.kernel.devices
    if (!devices) {
      throw new Error(`${this.providerName}: kernel.devices unavailable — cannot reload`)
    }
    const live = (await devices.getAll()).find((d) => d.stableId === stableId)
    if (live) await devices.decommission(live.id)

    const { id } = await this.ctx.api.deviceManager.allocateDeviceId.mutate({
      addonId: this.addonId,
      stableId,
    })
    const meta = await this.ctx.api.deviceManager.loadMeta.query({
      deviceId: id,
    })
    if (meta === null) {
      throw new Error(
        `${this.providerName}: no persisted meta for "${stableId}" (id ${id}) — cannot reload`,
      )
    }
    const deviceType = Object.values(DeviceType).find((t) => t === meta.type)
    const Class = deviceType !== undefined ? this.deviceClasses[deviceType] : undefined
    if (!Class) {
      throw new Error(
        `${this.providerName}: no device class for type "${meta.type}" — ` +
          `"${stableId}" is an accessory child; reload its parent instead`,
      )
    }
    await devices.create(stableId, Class, {}, meta.parentDeviceId ?? null)

    // Pass 2 of the boot restore, scoped to this parent: re-create first-class
    // children the decommission cascade tore down. Accessory children are
    // already back (the register flow re-ran `getAccessoryChildren()`), and
    // they carry no `deviceClasses` entry, so they are naturally skipped.
    const rows = await this.ctx.api.deviceManager.listPersistedByAddon.query({
      addonId: this.addonId,
    })
    for (const row of rows) {
      if (row.parentDeviceId !== id) continue
      const childType = Object.values(DeviceType).find((t) => t === row.type)
      const ChildClass = childType !== undefined ? this.deviceClasses[childType] : undefined
      if (!ChildClass) continue
      try {
        await devices.create(row.stableId, ChildClass, {}, id)
      } catch (err) {
        this.ctx.logger.warn('reloadDevice: failed to re-create first-class child', {
          tags: { deviceId: row.id, stableId: row.stableId },
          meta: {
            parentDeviceId: id,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }

    this.ctx.logger.info('device reloaded in place from persisted rows', {
      tags: { deviceId: id },
      meta: { stableId, type: meta.type },
    })
    return { deviceId: id }
  }

  // ── Subclass hooks ──────────────────────────────────────────────────

  /**
   * Concrete device classes this provider can spawn, keyed by
   * `DeviceType`. Used by:
   *   - `createDevice` to look up the class for the type the operator
   *     selected in the Add-Device modal
   *   - the default `onRestoreDevices` to instantiate persisted rows
   *     based on their `type` field
   *
   * Required for the declarative create + restore flow. Providers
   * that need custom-arg constructors (accessory child devices) wire
   * those up via `BaseDevice.getAccessoryChildren()` instead — the
   * top-level type → class map only handles parent devices.
   */
  protected abstract readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>>

  /** Return the creation form schema for a given device type, or null if unsupported. */
  protected abstract onGetCreationSchema(type: DeviceType): Promise<ConfigUISchema | null>

  /**
   * Build the create spec from operator-supplied form values. Returns
   * `{meta, config}` — kernel handles allocateId, persist, instantiate,
   * register, and accessory auto-spawn. Provider's only job is to:
   *   - validate / probe the input
   *   - emit the meta (`type`, `name`, optional `location`)
   *   - emit the `config` blob the device class will self-hydrate
   */
  protected abstract onCreateDevice(
    type: DeviceType,
    config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec>

  /**
   * Restore devices from persisted state. Two-pass:
   *
   * 1. **Top-level pass** — invokes `kernel.devices.create()` for every
   *    `parentDeviceId === null` row using the `deviceClasses` map.
   *    The kernel's register flow handles `getAccessoryChildren()` for
   *    each parent (siren / floodlight / PIR / etc).
   *
   * 2. **Hub-adopted children pass** — for rows with
   *    `parentDeviceId !== null` whose `type` IS in `deviceClasses`
   *    (e.g. Reolink hub-adopted cameras under an NVR), spawn them
   *    explicitly with the persisted `parentDeviceId`. These are
   *    NOT accessory children — they're first-class adopted devices
   *    that just happen to have a parent. Without this pass, every
   *    server restart would lose hub-adopted cameras (their type is
   *    in `deviceClasses` but parent's `getAccessoryChildren` doesn't
   *    spawn them — that callback is only for purpose-built
   *    accessory roles).
   *
   * Rows whose `type` is NOT in `deviceClasses` are skipped — those
   * are accessory children (siren/light/sensor) that the kernel's
   * accessory-spawn flow handles via the parent's
   * `getAccessoryChildren()`. Override only when the default doesn't
   * fit.
   *
   * A row that fails either pass is NOT terminal (D347): it is handed
   * to a bounded background retry (`DeviceRestoreRetryScheduler`).
   * Only after the bound is exhausted is the device marked permanently
   * failed — logged at ERROR with `tags.deviceId` and surfaced via
   * `getStatus().error`.
   */
  /**
   * Repair a row's PERSISTED config blob immediately before it is restored.
   * Default: no-op — most providers have nothing to heal.
   *
   * This exists because a restored device self-hydrates from the DB: `create()`
   * passes `{}` and `BaseDevice` parses the stored blob against the device
   * schema. A blob that lost a REQUIRED field therefore fails restore forever,
   * and no later pass revisits it — a hub-adopted Reolink camera whose blob had
   * been emptied failed all four bounded attempts against fields
   * (`host`, `password`) it inherits from its parent and never dials itself.
   *
   * Implementations get every saved row, so a child can read its parent's blob.
   * A heal that throws is treated like any other restore failure: retried under
   * the bound, then reported — never swallowed.
   */
  protected async healSavedConfig(
    _saved: SavedDevice,
    _allSaved: readonly SavedDevice[],
  ): Promise<void> {
    // no-op
  }

  protected async onRestoreDevices(
    savedDevices: readonly SavedDevice[],
  ): Promise<DeviceRestoreReport | void> {
    const restored = new Set<number>()
    const failures: InitialRestoreFailure[] = []

    // Rows the provider has ALREADY brought to life before this pass ran —
    // `onInitialize` may create a device the persisted set also names (the
    // HA event-bus aggregator does, whenever its broker connects first). The
    // registry refuses a second object under the same id, so dialling such a
    // row again is a guaranteed failure that the retry rounds cannot fix: the
    // device is running. Read once, before the fan-out, from the local registry.
    const liveStableIds = new Set(
      (await this.ctx.kernel.devices!.getAll()).map((device) => device.stableId),
    )

    // ONE attempt function for both passes AND the retry rounds. A child
    // whose parent hasn't landed yet throws — in the retry rounds that
    // failure is retried like any other, so a child terminally fails
    // only when its parent does.
    const attemptRestore = async (saved: SavedDevice): Promise<void> => {
      if (restored.has(saved.id)) return
      if (liveStableIds.has(saved.stableId)) {
        this.ctx.logger.debug('Restore row already live — not dialled again', {
          tags: { deviceId: saved.id, stableId: saved.stableId },
        })
        restored.add(saved.id)
        return
      }
      const Class = this.deviceClasses[saved.type] as DeviceConstructor<IDevice> | undefined
      if (!Class) {
        throw new Error(`no device class registered for type "${saved.type}"`)
      }
      if (saved.parentDeviceId !== null && !restored.has(saved.parentDeviceId)) {
        throw new Error(`parent device ${saved.parentDeviceId} not restored`)
      }
      // Last chance to repair the PERSISTED blob: `create()` passes `{}` and the
      // device self-hydrates from the DB, so a blob the schema rejects fails here
      // and nothing downstream revisits it. Default is a no-op.
      await this.healSavedConfig(saved, savedDevices)
      try {
        await this.ctx.kernel.devices!.create(saved.stableId, Class, {}, saved.parentDeviceId)
      } catch (err) {
        // The device may have come to life WHILE this dial was in flight
        // (`onInitialize` work racing the restore pass). A registry refusal
        // is then the proof it exists: re-read the registry before calling
        // it a failure, or every retry round collides with a running device.
        const nowLive = await this.ctx.kernel.devices!.getAll()
        if (!nowLive.some((device) => device.stableId === saved.stableId)) throw err
        this.ctx.logger.debug('Restore row came to life during its own dial — kept', {
          tags: { deviceId: saved.id, stableId: saved.stableId },
        })
      }
      restored.add(saved.id)
    }

    // Pass 1 — top-level. ALL AT ONCE: the rows are independent
    // (`parentDeviceId === null`). Each `create()` is a vendor dial; there is
    // no NVR in front of these cameras and a lane cap only delayed the last
    // camera (measured 6.5 min with 4 lanes). A camera that throws is logged
    // and skipped — it must not reject the fan-out (D167).
    const topLevel = savedDevices.filter((saved) => saved.parentDeviceId === null)
    const restoreOne = async (saved: SavedDevice): Promise<void> => {
      const Class = this.deviceClasses[saved.type] as DeviceConstructor<IDevice> | undefined
      if (!Class) {
        this.ctx.logger.warn('No device class registered for restored type — skipping', {
          tags: { deviceId: saved.id, stableId: saved.stableId },
          meta: { type: saved.type },
        })
        return
      }
      if (this.isUnrestorableShell(saved)) {
        this.quarantineShell(saved)
        return
      }
      try {
        await attemptRestore(saved)
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        this.ctx.logger.warn('Failed to restore device — bounded retry scheduled', {
          tags: { deviceId: saved.id, stableId: saved.stableId },
          meta: { type: saved.type, attempt: 1, error },
        })
        failures.push({ saved, error })
      }
    }
    await Promise.all(topLevel.map((saved) => restoreOne(saved)))
    // Ids of top-level rows that failed pass 1 but WILL be retried —
    // their hub-adopted children are deferred to the same retry.
    const failedTopLevelIds = new Set(failures.map((failure) => failure.saved.id))
    // Pass 2 runs only once pass 1 has FULLY settled: it spawns a child solely
    // when `restored` already holds its parent, so an incomplete set would
    // silently drop hub-adopted cameras.
    // Pass 2 — hub-adopted children (first-class devices with a parent
    // that is itself a registered device class). Iterates in order of
    // declared `parentDeviceId` to handle nested hubs gracefully.
    const childRows = savedDevices.filter((s) => s.parentDeviceId !== null)
    for (const saved of childRows) {
      const Class = this.deviceClasses[saved.type] as DeviceConstructor<IDevice> | undefined
      if (!Class) continue // not a first-class type → accessory, skip
      if (saved.parentDeviceId === null) continue
      if (restored.has(saved.parentDeviceId)) {
        try {
          await attemptRestore(saved)
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          this.ctx.logger.warn('Failed to restore hub-adopted child — bounded retry scheduled', {
            tags: {
              deviceId: saved.id,
              stableId: saved.stableId,
              parentDeviceId: saved.parentDeviceId,
            },
            meta: { type: saved.type, attempt: 1, error },
          })
          failures.push({ saved, error })
        }
        continue
      }
      if (failedTopLevelIds.has(saved.parentDeviceId)) {
        // Parent failed pass 1 but is being retried — defer the child to
        // the same retry rounds instead of dropping it (a silent drop is
        // how work disappears; log it).
        this.ctx.logger.warn('Hub-adopted child deferred — parent failed initial restore', {
          tags: {
            deviceId: saved.id,
            stableId: saved.stableId,
            parentDeviceId: saved.parentDeviceId,
          },
          meta: { type: saved.type },
        })
        failures.push({
          saved,
          error: `parent device ${saved.parentDeviceId} not restored`,
        })
        continue
      }
      // Parent isn't a known top-level device this provider owns —
      // probably a stale row pointing at a removed parent. Leave it
      // alone; orphan reconciliation runs later.
    }

    if (failures.length > 0) {
      this.scheduleRestoreRetries(failures, attemptRestore)
    }
    return { restoredCount: restored.size, failedCount: failures.length }
  }

  // ── Utility ─────────────────────────────────────────────────────────

  /** Convert an IDevice to the flat DeviceSummary for the cap router. */
  protected toSummary(device: IDevice): DeviceSummary {
    return toDeviceSummary(device, this.addonId)
  }
}
