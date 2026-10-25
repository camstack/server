import { MowerDevice as DreameMower, MowerFault } from '@apocaliss92/nodedreame'
import {
  consumablesCapability,
  type DeviceContext,
  errMsg,
  type InferNativeProvider,
  type LawnMowerControlStatus,
  lawnMowerControlCapability,
  RUNNING_STATE_COLD,
  type RunningStateStatus,
  runningFromLawnMower,
  runningStateCapability,
} from '@camstack/types'
import {
  clampBatteryLevel,
  clampPercent,
  mapMowerStatusToActivity,
} from '../dreame-mower-decode.js'
import { DreameChildDevice } from './dreame-child-device.js'
import {
  CONSUMABLES_CAP_NAME,
  CONSUMABLES_COLD_START,
  type ConsumablesSlice,
} from './dreame-consumables.js'
import { DreameMowerConsumables, MowerChargingEdge } from './dreame-mower-consumables.js'

const CAP_NAME = 'lawn-mower-control'
const RUNNING_CAP = 'running-state'

/**
 * The CMS consumable custom-action only answers while the mower is momentarily
 * awake and ACTIVELY charging — which it is the instant it docks with a depleted
 * battery. We ride that push (mirrors the donor `dreame-mower`
 * `_handle_device_update`: STATUS==CHARGING → refresh consumables). A
 * fully-charged / "charging complete" / sleeping mower at base does NOT answer
 * synchronous cloud commands (verified: every cloud action 80001s "device
 * offline", even with patient backoff), so a periodic poll never works — it is
 * intentionally NOT used here. We trigger on the transition into EITHER
 * `status == Charging` OR `chargingStatus == Charging`, since both mark the
 * awake-and-charging window, to maximise the capture chance.
 */

/**
 * Cloud-shadow (no-wake) refresh cadence for the mower's battery / charging /
 * status props. The shadow read (`refreshFromCache` → `getCachedProperties`)
 * hits the cloud SHADOW, not the device — so it succeeds even while the mower
 * sleeps at base, UNLIKE the synchronous CMS action above (which 80001s). The
 * mower never PUSHES battery over MQTT, so without this poll `batteryLevel`
 * stays null. A gentle interval keeps the level current as it charges.
 */
const SHADOW_POLL_MS = 120_000

const COLD_START: LawnMowerControlStatus = {
  activity: 'idle',
  batteryLevel: null,
  progressPercent: null,
  currentCode: null,
  currentCodeLabel: null,
  severity: 'info',
  lastChangedAt: 0,
}

/**
 * Dreame robotic lawn-mower device. Registers the `lawn-mower-control` and
 * `consumables` caps and maps the library `MowerDevice` getters → the cap slice
 * on every `stateChanged` push.
 *
 * Commands route to the live handle: `startMowing`→`startMowing()`, `pause`→
 * `pause()`, `dock`→`dock()`. The library's `stop`/`resume` are NOT surfaced —
 * the `lawn-mower-control` cap exposes only start/pause/dock; `stop` collapses
 * onto `pause` semantically.
 *
 * Consumables (blade / brush / maintenance) are NOT cached MIoT props — they are
 * read via a LIVE CMS custom-action (`getConsumables()`) that only answers while
 * the mower is awake. We fetch best-effort on activate, on the charging push
 * transition (the wake window — see {@link recomputeSlice}), and after a reset.
 * The `consumables` slice is `restored` across restarts, so the last good
 * reading is shown while the mower sleeps; a failed or empty read never
 * overwrites it (see `DreameMowerConsumables`).
 *
 * TODO: map data (`getMap()`/`mapSvg()`) is deferred — there is no camstack map
 * cap, and the mower `getMap()` even requires an injected batch fetcher.
 */
export class DreameMowerDevice extends DreameChildDevice {
  /** The edge into the charging wake window (the first push after boot is not one). */
  readonly #chargingEdge = new MowerChargingEdge()
  /** Periodic cloud-shadow refresh timer (battery / charging / status). */
  #shadowTimer: ReturnType<typeof setInterval> | null = null
  /** CMS consumables: read on activate / charging edge / reset, never overlapping. */
  readonly #consumables = new DreameMowerConsumables({
    deviceId: this.id,
    logger: this.ctx.logger,
    store: this.runtimeState,
    resolveMower: () => this.resolveMower(),
  })

  // Widens the base's `protected` constructor to public so `dreameChildFactory`
  // can `new` it. The forward is required for the visibility change.
  // oxlint-disable-next-line no-useless-constructor
  constructor(ctx: DeviceContext) {
    super(ctx)
  }

  /** Narrow the generic handle to the library's typed {@link DreameMower}, or null. */
  private resolveMower(): DreameMower | null {
    const handle = this.resolveHandle()
    return handle instanceof DreameMower ? handle : null
  }

  protected override registerControlCap(): void {
    const controlProvider: InferNativeProvider<typeof lawnMowerControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<LawnMowerControlStatus>(CAP_NAME) ?? COLD_START,
      startMowing: async () => {
        await this.requireMower().startMowing()
      },
      pause: async () => {
        await this.requireMower().pause()
      },
      dock: async () => {
        await this.requireMower().dock()
      },
    }
    this.ctx.registerNativeCap(lawnMowerControlCapability, controlProvider)
    const runningProvider: InferNativeProvider<typeof runningStateCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<RunningStateStatus>(RUNNING_CAP) ?? RUNNING_STATE_COLD,
    }
    this.ctx.registerNativeCap(runningStateCapability, runningProvider)
    this.runtimeState.setCapState(CAP_NAME, COLD_START)
    this.runtimeState.setCapState(RUNNING_CAP, RUNNING_STATE_COLD)

    // The consumables cap is seeded here (before the parent's first
    // recomputeSlice) so its schema exists; its items are filled by the LIVE CMS
    // fetch on activate / the CHARGING transition / reset(), not by recomputeSlice.
    const consumablesProvider: InferNativeProvider<typeof consumablesCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<ConsumablesSlice>(CONSUMABLES_CAP_NAME) ??
        CONSUMABLES_COLD_START,
      reset: async ({ key }) => {
        await this.#consumables.reset(key)
      },
    }
    this.ctx.registerNativeCap(consumablesCapability, consumablesProvider)
    // The CMS counters are readable only in the brief charging wake window, and
    // the slice is `restored` across restarts: seed the cold start ONLY when
    // nothing was restored, so the last good reading survives boot.
    this.#consumables.seed()
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // One best-effort CMS read on activate (succeeds only if the mower happens to
    // be awake right now; otherwise the restored last-good reading stays shown).
    // No periodic CMS poll — a sleeping mower never answers, and the CHARGING-push
    // transition (see recomputeSlice) is the reliable refresh trigger.
    void this.#consumables.refresh('activate')
    // Battery / charging / status are cached MIoT props absent from the MQTT
    // push stream — seed them from the cloud shadow (no-wake) now and on a gentle
    // interval, else `batteryLevel` stays null. Distinct from the CMS action:
    // the shadow read works even while the mower sleeps.
    void this.#refreshShadow()
    this.#shadowTimer = setInterval(() => {
      void this.#refreshShadow()
    }, SHADOW_POLL_MS)
  }

  override async removeDevice(): Promise<void> {
    if (this.#shadowTimer) {
      clearInterval(this.#shadowTimer)
      this.#shadowTimer = null
    }
    this.#consumables.stop()
    await super.removeDevice()
  }

  /**
   * Seed the cached MIoT props (battery / charging / status …) from the CLOUD
   * SHADOW — a no-wake read that succeeds even while the mower sleeps at base.
   * `refreshFromCache` emits `stateChanged`, which drives `recomputeSlice`, so
   * the battery level lands in the slice. Best-effort; failures log at debug.
   */
  async #refreshShadow(): Promise<void> {
    const mower = this.resolveMower()
    if (mower === null) return
    try {
      await mower.refreshFromCache()
    } catch (err) {
      this.ctx.logger.debug('dreame mower: cloud-shadow refresh failed', {
        tags: { deviceId: this.id },
        meta: { dreameDeviceId: this.dreameDeviceId, error: errMsg(err) },
      })
    }
  }

  protected override recomputeSlice(): void {
    const mower = this.resolveMower()
    if (mower === null) return
    const status = mower.status
    const code = mower.faultRaw
    // Mowing progress (pose-coverage 1:4) is push-only telemetry — it is absent
    // from the cloud shadow, so a docked/just-restarted mower reads null. Mirror
    // the Dreamehome app / HA: preserve the LAST known progress instead of
    // blanking it when the live value is momentarily null.
    const livePct = clampPercent(mower.mowingProgressPct)
    const prevPct = this.runtimeState.getCapState<LawnMowerControlStatus>(CAP_NAME)?.progressPercent
    const slice: LawnMowerControlStatus = {
      activity: mapMowerStatusToActivity(status),
      batteryLevel: clampBatteryLevel(mower.battery),
      progressPercent: livePct ?? prevPct ?? null,
      currentCode: code,
      currentCodeLabel: code !== null ? (MowerFault[code] ?? null) : null,
      severity: mower.faultSeverity,
      lastChangedAt: Date.now(),
    }
    this.runtimeState.setCapState(CAP_NAME, slice)
    const fetchedAt = Date.now()
    const previous = this.runtimeState.getCapState<RunningStateStatus>(RUNNING_CAP)
    const activityForRunning = status === null ? null : mapMowerStatusToActivity(status)
    this.runtimeState.setCapState(
      RUNNING_CAP,
      runningFromLawnMower(activityForRunning, previous, fetchedAt, slice.lastChangedAt),
    )

    // Ride the wake window: the CMS custom-action answers only while the mower is
    // momentarily awake, which it is the instant it docks and enters CHARGING.
    // Fetch once on the transition INTO charging — keyed on status OR chargingStatus
    // (either marks the awake-and-charging window; mirrors the donor integration).
    if (this.#chargingEdge.observe(status, mower.charging)) {
      void this.#consumables.refresh('charging')
    }
  }

  /** The live typed mower handle, or throw a clear error when disconnected. */
  private requireMower(): DreameMower {
    const mower = this.resolveMower()
    if (mower === null) {
      throw new Error(`DreameMowerDevice: mower handle unavailable (device=${this.dreameDeviceId})`)
    }
    return mower
  }
}
