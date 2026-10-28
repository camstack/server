import { VacuumDevice as DreameVacuum, type MiotProp } from '@apocaliss92/nodedreame'
import {
  consumablesCapability,
  type DeviceContext,
  errMsg,
  type InferNativeProvider,
  networkLinkCapability,
  RUNNING_STATE_COLD,
  type RunningStateStatus,
  runningFromVacuumState,
  runningStateCapability,
  type VacuumControlStatus,
  vacuumControlCapability,
} from '@camstack/types'
import type { VacuumTankProps } from '../dreame-vacuum-decode.js'
import {
  clampBatteryLevel,
  clampPercent,
  decodeVacuumTanks,
  vacuumTankItems,
  mapMiotStateToVacuumState,
  nextVacuumControlSlice,
  suctionLevelToken,
  supportedFanSpeedTokens,
  tokenToSuctionLevel,
  VACUUM_TANK_PROPS,
  vacuumErrorLabel,
} from '../dreame-vacuum-decode.js'
import { DreameChildDevice } from './dreame-child-device.js'
import {
  CONSUMABLES_CAP_NAME,
  CONSUMABLES_COLD_START,
  type ConsumablesSlice,
  seedConsumablesColdStart,
} from './dreame-consumables.js'
import { DreameVacuumConsumables } from './dreame-vacuum-consumables.js'
import { DreameNetworkLinkMonitor } from './dreame-network-link.js'

const CAP_NAME = 'vacuum-control'
const RUNNING_CAP = 'running-state'

const CONTROL_COLD_START: VacuumControlStatus = {
  state: 'idle',
  batteryLevel: null,
  fanSpeed: null,
  availableFanSpeeds: [],
  progressPercent: null,
  errorCode: null,
  errorLabel: null,
  lastChangedAt: 0,
}

/**
 * Dreame robot-vacuum device. Registers the `vacuum-control` and `consumables`
 * caps and maps the library `VacuumDevice` getters → the cap slices on every
 * `stateChanged` push.
 *
 * Commands route to the live handle: `start`→`startCleaning()`, `pause`→
 * `pause()`, `stop`→`stop()`, `returnToBase`→`dock()`, `locate`→`locate()`,
 * `setFanSpeed`→`setSuction()` (token validated against the model's supported
 * suction levels).
 *
 * Tanks (clean water / dirty water / detergent / dust bin) are `supply` /
 * `waste` items of the `consumables` slice (D915), not `vacuum-control` fields:
 * the library exposes NO tank fill LEVEL, so `level` is always null. PRESENCE
 * comes from the model capability flags and a discrete `status` from the
 * station's tank-status enum props (`decodeVacuumTanks`, ids in
 * `VACUUM_TANK_PROPS`); an absent tank is no item, an unknown status is `null`
 * — never `ok`.
 *
 * Consumables: whatever the model REPORTS (the library's presence-driven
 * `supportedConsumables`), re-read from the cloud shadow on activate, hourly and
 * on the edge into docked. `reset()` accepts only a key this robot reports and
 * can reset, drives its MIoT reset action, and rebuilds the slice from the
 * library's post-reset re-read (see `DreameVacuumConsumables`).
 *
 * Map data is NOT on this device: the cleaning map is surfaced as a separate
 * `image` child (`DreameVacuumMapDevice`) grouped under the same Container, per
 * the Dreame container directive (non-robot entities are container children,
 * not folded onto the Vacuum). Room/segment helpers (`cleanSegments` etc.)
 * remain command-side here.
 */
export class DreameVacuumDevice extends DreameChildDevice {
  // Widens the base's `protected` constructor to public so `dreameChildFactory`
  // can `new` it. The forward is required for the visibility change.
  // oxlint-disable-next-line no-useless-constructor
  constructor(ctx: DeviceContext) {
    super(ctx)
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // The robot's own link. A first read at activation, then every
    // NETWORK_LINK_REFRESH_MS: the only source is the Wi-Fi signal map (a
    // cloud round trip), and the bars at the dock do not change by the minute.
    this.networkLink.start()
    // The AI-obstacle toggles are STATIC settings the robot rarely re-pushes
    // over MQTT, so a fresh connect has no cached AI_DETECTION value and the
    // sibling AI-switch children would all read their cold-start `false`. Seed
    // it ONCE from the cloud shadow here (shared handle) — the resulting
    // `stateChanged` fans out to every AI-switch child's listener. Best-effort.
    const vacuum = this.resolveVacuum()
    if (vacuum !== null) {
      // Seed the live state machine (STATE/battery/suction/… DEFAULT_PROPS) from
      // the cloud SHADOW. The robot pushes STATE (siid 2 piid 1) only on
      // TRANSITIONS over MQTT — a handle that connects MID-CLEAN never saw the
      // idle→cleaning transition, so without this seed `vacuum.status` stays at its
      // stale connect-time value and the slice reads `idle` while the robot cleans.
      // The seed emits `stateChanged`, which recomputes the control slice. Battery
      // keeps updating live; STATE then tracks the next transition.
      vacuum.refreshFromCache().catch((err: unknown) => {
        this.ctx.logger.debug('dreame vacuum: state seed failed', {
          tags: { deviceId: this.id },
          meta: { dreameDeviceId: this.dreameDeviceId, error: errMsg(err) },
        })
      })
      vacuum.refreshAiDetection().catch((err: unknown) => {
        this.ctx.logger.debug('dreame vacuum: AI_DETECTION seed failed', {
          tags: { deviceId: this.id },
          meta: { dreameDeviceId: this.dreameDeviceId, error: errMsg(err) },
        })
      })
    }
    // Consumable life %s + time-left twins + tank statuses: rarely re-pushed over
    // MQTT, so re-read from the cloud shadow now, hourly, and on the dock edge.
    this.consumables.start()
  }

  /** Consumables refresh + reset — see `DreameVacuumConsumables`. */
  private readonly consumables = new DreameVacuumConsumables({
    deviceId: this.id,
    logger: this.ctx.logger,
    store: this.runtimeState,
    resolveVacuum: () => this.resolveVacuum(),
  })

  /** Narrow the generic handle to the library's typed {@link DreameVacuum}, or null. */
  /** The robot's own link — one reader shared with the camera child. */
  private readonly networkLink = new DreameNetworkLinkMonitor({
    deviceId: this.id,
    logger: this.ctx.logger,
    runtimeState: this.runtimeState,
    readBars: () => {
      const vacuum = this.resolveVacuum()
      return vacuum === null ? null : vacuum.getCurrentSignal({ maxWaitMs: 20_000 })
    },
  })

  /** `network-link`: the read path serves the slice; the monitor writes it. */
  private registerNetworkLink(): void {
    this.ctx.registerNativeCap(networkLinkCapability, this.networkLink.provider())
    this.networkLink.seed()
  }

  override async removeDevice(): Promise<void> {
    this.networkLink.stop()
    this.consumables.stop()
    await super.removeDevice()
  }

  private resolveVacuum(): DreameVacuum | null {
    const handle = this.resolveHandle()
    return handle instanceof DreameVacuum ? handle : null
  }

  protected override registerControlCap(): void {
    this.registerNetworkLink()
    const provider: InferNativeProvider<typeof vacuumControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<VacuumControlStatus>(CAP_NAME) ?? CONTROL_COLD_START,
      start: async () => {
        await this.requireVacuum().startCleaning()
      },
      pause: async () => {
        await this.requireVacuum().pause()
      },
      stop: async () => {
        await this.requireVacuum().stop()
      },
      returnToBase: async () => {
        await this.requireVacuum().dock()
      },
      locate: async () => {
        await this.requireVacuum().locate()
      },
      setFanSpeed: async ({ speed }) => {
        const vacuum = this.requireVacuum()
        const level = tokenToSuctionLevel(speed, vacuum.supportedSuctionLevels)
        if (level === null) {
          throw new Error(`dreame vacuum: unsupported fan speed "${speed}"`)
        }
        await vacuum.setSuction(level)
      },
    }
    this.ctx.registerNativeCap(vacuumControlCapability, provider)
    this.registerRunningCap()
    this.runtimeState.setCapState(CAP_NAME, CONTROL_COLD_START)
    this.runtimeState.setCapState(RUNNING_CAP, RUNNING_STATE_COLD)
    // Register the consumables cap HERE so its schema is seeded before the
    // parent's onActivate calls recomputeSlice(), which writes to it.
    this.registerConsumablesCap()
  }

  /**
   * Register the `consumables` cap. The provider surfaces remaining life % for
   * every consumable the model REPORTS (presence-driven via the library's
   * `supportedConsumables`); `reset()` drives the consumable's real MIoT reset
   * action. Items whose model has no reset action report `resettable: false`
   * (the UI suppresses the button, and `reset()` refuses them).
   */
  protected registerConsumablesCap(): void {
    const provider: InferNativeProvider<typeof consumablesCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<ConsumablesSlice>(CONSUMABLES_CAP_NAME) ??
        CONSUMABLES_COLD_START,
      reset: async ({ key }) => {
        await this.consumables.reset(key)
      },
    }
    this.ctx.registerNativeCap(consumablesCapability, provider)
    // The slice is restored across restarts: never wipe the last reading here.
    seedConsumablesColdStart(this.runtimeState)
  }

  protected override recomputeSlice(): void {
    const vacuum = this.resolveVacuum()
    if (vacuum === null) return

    // The error code feeds the dirty-water tank: MiotError.DirtyWaterTankFull is its "full".
    const tanks = vacuumTankItems(
      decodeVacuumTanks(vacuum.vacuumCapabilities, this.readTankProps(), vacuum.errorCode),
    )
    const miotStatus = vacuum.status
    const controlSlice: VacuumControlStatus = {
      state: mapMiotStateToVacuumState(miotStatus),
      batteryLevel: clampBatteryLevel(vacuum.battery),
      fanSpeed: suctionLevelToken(vacuum.suction),
      availableFanSpeeds: supportedFanSpeedTokens(vacuum.supportedSuctionLevels),
      progressPercent: clampPercent(vacuum.taskProgressPct),
      errorCode: vacuum.errorCode,
      errorLabel: vacuumErrorLabel(vacuum.errorCode),
      lastChangedAt: Date.now(),
    }
    const toWrite = nextVacuumControlSlice(
      this.runtimeState.getCapState<VacuumControlStatus>(CAP_NAME),
      controlSlice,
    )
    if (toWrite !== null) this.runtimeState.setCapState(CAP_NAME, toWrite)
    this.publishRunningSlice(miotStatus, Date.now(), controlSlice.lastChangedAt)
    // Replays the cache and the tanks into the consumables slice (only on a
    // change, never an empty list) and refreshes on the edge into docked.
    this.consumables.onPush(controlSlice.state, tanks)
  }

  /**
   * Read the tank-status MIoT enum props ({@link VACUUM_TANK_PROPS}) from the
   * live handle for {@link decodeVacuumTanks}. Each is `null` when the device
   * reports no such property (or a non-numeric value), so a model without these
   * props simply falls back to presence-only tanks.
   */
  private readTankProps(): VacuumTankProps {
    const vacuum = this.resolveVacuum()
    const readEnum = (prop: MiotProp): number | null => {
      const value = vacuum?.getProperty(prop.siid, prop.piid)?.value
      return typeof value === 'number' ? value : null
    }
    return {
      cleanWaterTankStatus: readEnum(VACUUM_TANK_PROPS.cleanWaterTankStatus),
      waterTank: readEnum(VACUUM_TANK_PROPS.waterTank),
      detergentStatus: readEnum(VACUUM_TANK_PROPS.detergentStatus),
      dustCollection: readEnum(VACUUM_TANK_PROPS.dustCollection),
      dirtyWaterTankStatus: readEnum(VACUUM_TANK_PROPS.dirtyWaterTankStatus),
      dustBagStatus: readEnum(VACUUM_TANK_PROPS.dustBagStatus),
    }
  }

  private registerRunningCap(): void {
    const provider: InferNativeProvider<typeof runningStateCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<RunningStateStatus>(RUNNING_CAP) ?? RUNNING_STATE_COLD,
    }
    this.ctx.registerNativeCap(runningStateCapability, provider)
  }

  private publishRunningSlice(
    miotStatus: DreameVacuum['status'],
    fetchedAt: number,
    transitionAt: number,
  ): void {
    const previous = this.runtimeState.getCapState<RunningStateStatus>(RUNNING_CAP)
    const next = runningFromVacuumState(
      miotStatus === null ? null : mapMiotStateToVacuumState(miotStatus),
      previous,
      fetchedAt,
      transitionAt,
    )
    this.runtimeState.setCapState(RUNNING_CAP, next)
  }

  /** The live typed vacuum handle, or throw a clear error when disconnected. */
  private requireVacuum(): DreameVacuum {
    const vacuum = this.resolveVacuum()
    if (vacuum === null) {
      throw new Error(
        `DreameVacuumDevice: vacuum handle unavailable (device=${this.dreameDeviceId})`,
      )
    }
    return vacuum
  }
}
