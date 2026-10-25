import {
  type AccessoryChildSpec,
  BaseDevice,
  type DeviceContext,
  DeviceFeature,
  DeviceRole,
  DeviceType,
  errMsg,
  type FanControlStatus,
  fanControlCapability,
  type IDevice,
  type InferNativeProvider,
  type SwitchStatus,
  switchCapability,
} from '@camstack/types'
import { vesyncPurifierSchema, type VeSyncSensorKind, type VeSyncToggleKind } from '../config.js'
import type { VeSyncClient, VeSyncPurifierSnapshot } from '../vesync-client-contract.js'
import { vesyncAccounts } from '../vesync-account-resolver.js'
import { VeSyncSensorDevice } from './vesync-sensor-device.js'
import { VeSyncToggleDevice } from './vesync-toggle-device.js'

const SWITCH_CAP = switchCapability.name
const FAN_CAP = fanControlCapability.name

const SWITCH_COLD_START: SwitchStatus = { on: false, lastChangedAt: 0 }
const FAN_COLD_START: FanControlStatus = {
  percentage: null,
  preset: '',
  availablePresets: [],
  direction: null,
  oscillating: null,
  lastChangedAt: 0,
}

/** One accessory child the purifier fans out. */
interface AccessoryPlan {
  readonly suffix: string
  readonly type: DeviceType
  readonly role: DeviceRole
  readonly nameSuffix: string
  readonly config: Record<string, unknown>
  readonly factory: (ctx: DeviceContext) => IDevice
}

/**
 * One VeSync air purifier as a CamStack {@link DeviceType.Fan} device. A CHILD of
 * the account Hub device (standalone mode). Registers TWO caps on itself:
 *   - `switch`       — the main power on/off (per the `fan-control` cap doc, the
 *                      on/off state lives on `switch`, mirroring the Light pattern).
 *   - `fan-control`  — speed percentage + preset mode.
 *
 * It fans four accessory children out via `getAccessoryChildren()` (a device can
 * register a given cap name only once, so the two extra toggles cannot be `switch`
 * caps on the Fan):
 *   - child-lock  → {@link DeviceType.Switch} ({@link VeSyncToggleDevice})
 *   - display     → {@link DeviceType.Switch} ({@link VeSyncToggleDevice})
 *   - air-quality → {@link DeviceType.Sensor} ({@link VeSyncSensorDevice}, air-quality-sensor)
 *   - filter-life → {@link DeviceType.Sensor} ({@link VeSyncSensorDevice}, numeric-sensor %)
 *
 * The slices are fed from the live account snapshot on each poll tick (and seeded
 * cold on activate). Commands are driven through the live client resolved from
 * {@link vesyncAccounts}.
 *
 * NOTE: the HA `night_light_level` select (`off` / `dim` / `on`) is intentionally
 * NOT surfaced — there is no clean existing cap for a 3-option settable select.
 * See `plan-vesync.md` (new `select-control` cap follow-up).
 */
export class VeSyncPurifierDevice extends BaseDevice<typeof vesyncPurifierSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.FanSpeed, DeviceFeature.FanPreset]

  private readonly purifierNativeId: string
  private readonly accountId: string

  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = vesyncPurifierSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, vesyncPurifierSchema, { type: DeviceType.Fan })
    this.purifierNativeId = cfg.purifierNativeId
    this.accountId = cfg.accountId
    this.online = vesyncAccounts.getPurifier(this.accountId, this.purifierNativeId)?.online ?? false
    this.registerSwitchCap()
    this.registerFanCap()
    this.runtimeState.setCapState(SWITCH_CAP, SWITCH_COLD_START)
    this.runtimeState.setCapState(FAN_CAP, FAN_COLD_START)
    void this.updateSourceInfo({
      id: `${this.accountId}:${this.purifierNativeId}`,
      system: 'vesync',
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.attachSnapshotListener()
    this.recomputeSlices()
  }

  override async removeDevice(): Promise<void> {
    if (this.snapshotUnsub) {
      try {
        this.snapshotUnsub()
      } catch {
        // best-effort
      }
      this.snapshotUnsub = null
    }
    await super.removeDevice()
  }

  /** Fan out the fixed accessory children (2 Switch toggles + 2 Sensor metrics). */
  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    return this.accessoryPlans().map((plan) => {
      const meta: AccessoryChildSpec['meta'] = {
        type: plan.type,
        role: plan.role,
        name: `${this.name} — ${plan.nameSuffix}`,
        linkDeviceId: this.id,
      }
      return {
        stableIdSuffix: plan.suffix,
        meta,
        config: plan.config,
        factory: plan.factory,
      } satisfies AccessoryChildSpec
    })
  }

  private accessoryPlans(): readonly AccessoryPlan[] {
    const base = {
      purifierNativeId: this.purifierNativeId,
      accountId: this.accountId,
      system: 'vesync',
    }
    const toggle = (kind: VeSyncToggleKind): Record<string, unknown> => ({ ...base, kind })
    const sensor = (kind: VeSyncSensorKind): Record<string, unknown> => ({ ...base, kind })
    return [
      {
        suffix: 'child-lock',
        type: DeviceType.Switch,
        role: DeviceRole.BinaryHelper,
        nameSuffix: 'Child lock',
        config: toggle('child-lock'),
        factory: (ctx: DeviceContext): IDevice => new VeSyncToggleDevice(ctx),
      },
      {
        suffix: 'display',
        type: DeviceType.Switch,
        role: DeviceRole.BinaryHelper,
        nameSuffix: 'Display',
        config: toggle('display'),
        factory: (ctx: DeviceContext): IDevice => new VeSyncToggleDevice(ctx),
      },
      {
        suffix: 'air-quality',
        type: DeviceType.Sensor,
        role: DeviceRole.AirQualitySensor,
        nameSuffix: 'Air quality',
        config: sensor('air-quality'),
        factory: (ctx: DeviceContext): IDevice => new VeSyncSensorDevice(ctx),
      },
      {
        suffix: 'filter-life',
        type: DeviceType.Sensor,
        role: DeviceRole.NumericSensor,
        nameSuffix: 'Filter life',
        config: sensor('filter-life'),
        factory: (ctx: DeviceContext): IDevice => new VeSyncSensorDevice(ctx),
      },
    ]
  }

  private attachSnapshotListener(): void {
    const onSnapshot = (): void => {
      try {
        this.recomputeSlices()
      } catch (err) {
        this.ctx.logger.warn('vesync purifier: snapshot handler error', {
          meta: { purifierNativeId: this.purifierNativeId, error: errMsg(err) },
        })
      }
    }
    this.snapshotUnsub = vesyncAccounts.onSnapshot(this.accountId, onSnapshot)
  }

  /** Recompute + write the `switch` + `fan-control` slices from the live snapshot. */
  private recomputeSlices(): void {
    const purifier = vesyncAccounts.getPurifier(this.accountId, this.purifierNativeId)
    if (purifier === null) return
    if (this.online !== purifier.online) this.markOnline(purifier.online)
    const now = Date.now()
    this.runtimeState.setCapState(SWITCH_CAP, { on: purifier.power, lastChangedAt: now })
    this.runtimeState.setCapState(FAN_CAP, fanSlice(purifier, now))
  }

  private resolveClient(): VeSyncClient {
    const client = vesyncAccounts.getManager(this.accountId)?.client ?? null
    if (client === null) {
      throw new Error(
        `VeSync purifier ${this.purifierNativeId}: account ${this.accountId} client is not available`,
      )
    }
    return client
  }

  private registerSwitchCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<SwitchStatus>(SWITCH_CAP) ?? SWITCH_COLD_START,
      setState: async ({ on }) => {
        await this.resolveClient().setPower(this.purifierNativeId, on)
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
  }

  private registerFanCap(): void {
    const provider: InferNativeProvider<typeof fanControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<FanControlStatus>(FAN_CAP) ?? FAN_COLD_START,
      setPercentage: async ({ percentage }) => {
        const client = this.resolveClient()
        if (percentage <= 0) {
          await client.setPower(this.purifierNativeId, false)
          return
        }
        const purifier = vesyncAccounts.getPurifier(this.accountId, this.purifierNativeId)
        if (purifier !== null && !purifier.power) {
          await client.setPower(this.purifierNativeId, true)
        }
        await client.setFanSpeed(this.purifierNativeId, percentage)
      },
      setPreset: async ({ preset }) => {
        await this.resolveClient().setMode(this.purifierNativeId, preset)
      },
      setDirection: async ({ direction }) => {
        throw new Error(`vesync purifier: direction control not supported (got "${direction}")`)
      },
      setOscillating: async ({ oscillating }) => {
        throw new Error(`vesync purifier: oscillation not supported (got ${String(oscillating)})`)
      },
    }
    this.ctx.registerNativeCap(fanControlCapability, provider)
  }
}

/** Map a purifier snapshot onto the `fan-control` cap status (speed + preset). */
function fanSlice(purifier: VeSyncPurifierSnapshot, now: number): FanControlStatus {
  return {
    percentage: purifier.speedPercent,
    ...(purifier.percentageStep !== undefined ? { percentageStep: purifier.percentageStep } : {}),
    preset: purifier.preset,
    availablePresets: [...purifier.availablePresets],
    direction: null,
    oscillating: null,
    lastChangedAt: now,
  }
}
