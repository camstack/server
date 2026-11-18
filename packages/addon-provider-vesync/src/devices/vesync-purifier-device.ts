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
import { registerVeSyncStateRefresh } from './vesync-state-refresh.js'
import { describeSpeedSteps, planPurifierSpeed, runSpeedSteps } from '../vesync-commands.js'
import { vesyncIdentifiers } from '../vesync-identifiers.js'
import { VeSyncSensorDevice } from './vesync-sensor-device.js'
import { VeSyncToggleDevice } from './vesync-toggle-device.js'

const SWITCH_CAP = switchCapability.name
const FAN_CAP = fanControlCapability.name

const SWITCH_COLD_START: SwitchStatus = { on: false, lastChangedAt: 0 }
const FAN_COLD_START: FanControlStatus = {
  speed: null,
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
 * One VeSync air purifier as a CamStack {@link DeviceType.Fan} device. A sibling of
 * the account Gateway. Registers TWO caps on itself:
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
 * cold on activate). Commands go through the account manager's `runCommand`, which
 * re-reads this purifier right after the cloud acknowledged and pushes its real state.
 * A speed set while a preset (Auto, Sleep) runs switches the purifier to Manual first.
 *
 * NOTE: the HA `night_light_level` select (`off` / `dim` / `on`) is intentionally
 * NOT surfaced — there is no clean existing cap for a 3-option settable select.
 * See `plan-vesync.md` (new `select-control` cap follow-up).
 */
export class VeSyncPurifierDevice extends BaseDevice<typeof vesyncPurifierSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.FanSpeed, DeviceFeature.FanPreset]

  private readonly purifierNativeId: string
  private readonly integrationId: string

  private snapshotUnsub: (() => void) | null = null
  /** Stops the core state refresh's re-registration (D1062). */
  private stopStateRefresh: (() => void) | null = null
  /** The last identity declaration that landed (D1059); an unchanged one is not re-sent. */
  private lastIdentityKey: string | null = null

  constructor(ctx: DeviceContext) {
    const cfg = vesyncPurifierSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, vesyncPurifierSchema, { type: DeviceType.Fan })
    this.purifierNativeId = cfg.purifierNativeId
    this.integrationId = cfg.integrationId
    this.online =
      vesyncAccounts.getPurifier(this.integrationId, this.purifierNativeId)?.online ?? false
    this.registerSwitchCap()
    this.registerFanCap()
    this.runtimeState.setCapState(SWITCH_CAP, SWITCH_COLD_START)
    this.runtimeState.setCapState(FAN_CAP, FAN_COLD_START)
    void this.updateSourceInfo({
      id: `${this.integrationId}:${this.purifierNativeId}`,
      system: 'vesync',
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // The core decides when this device is re-read (D1062); VeSync only reads.
    this.stopStateRefresh ??= registerVeSyncStateRefresh({
      ctx: this.ctx,
      deviceId: this.id,
      integrationId: this.integrationId,
      nativeId: this.purifierNativeId,
    })
    this.attachSnapshotListener()
    this.recomputeSlices()
  }

  override async removeDevice(): Promise<void> {
    this.stopStateRefresh?.()
    this.stopStateRefresh = null
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
      integrationId: this.integrationId,
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
          tags: { deviceId: this.id },
          meta: { purifierNativeId: this.purifierNativeId, error: errMsg(err) },
        })
      }
    }
    this.snapshotUnsub = vesyncAccounts.onSnapshot(this.integrationId, onSnapshot)
  }

  /** Recompute + write the `switch` + `fan-control` slices from the live snapshot. */
  private recomputeSlices(): void {
    const purifier = vesyncAccounts.getPurifier(this.integrationId, this.purifierNativeId)
    if (purifier === null) return
    if (this.online !== purifier.online) this.markOnline(purifier.online)
    const now = Date.now()
    this.runtimeState.setCapState(SWITCH_CAP, { on: purifier.power, lastChangedAt: now })
    this.runtimeState.setCapState(FAN_CAP, fanSlice(purifier, now))
    void this.declareIdentity(purifier)
  }

  /** Declare the cloud cid and the MAC as typed identifiers (D1059), when they changed. */
  private async declareIdentity(purifier: VeSyncPurifierSnapshot): Promise<void> {
    const declaration = vesyncIdentifiers(purifier)
    if (declaration === null) return
    const key = JSON.stringify(declaration)
    if (key === this.lastIdentityKey) return
    this.lastIdentityKey = key
    const result = await this.declareIdentifiers(declaration.identifiers, {
      unread: declaration.unread,
    })
    if (result.outcome !== 'declared') this.lastIdentityKey = null
  }

  /** Send one command through the account manager; the core re-reads the device after it (D1062). */
  private async command(name: string, run: (client: VeSyncClient) => Promise<void>): Promise<void> {
    const manager = vesyncAccounts.getManager(this.integrationId)
    if (manager === null) {
      throw new Error(
        `VeSync purifier ${this.purifierNativeId}: integration ${this.integrationId} is not available`,
      )
    }
    await manager.runCommand({ nativeId: this.purifierNativeId, deviceId: this.id, name, run })
  }

  private registerSwitchCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<SwitchStatus>(SWITCH_CAP) ?? SWITCH_COLD_START,
      setState: async ({ on }) => {
        await this.command(`setPower(${on ? 'on' : 'off'})`, (client) =>
          client.setPower(this.purifierNativeId, on),
        )
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
  }

  private registerFanCap(): void {
    const provider: InferNativeProvider<typeof fanControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<FanControlStatus>(FAN_CAP) ?? FAN_COLD_START,
      setPercentage: async ({ speed: percentage }) => {
        const purifier = vesyncAccounts.getPurifier(this.integrationId, this.purifierNativeId)
        const steps = planPurifierSpeed(purifier, percentage)
        await this.command(describeSpeedSteps(steps), (client) =>
          runSpeedSteps(client, this.purifierNativeId, steps),
        )
      },
      setPreset: async ({ preset }) => {
        await this.command(`setMode(${preset})`, (client) =>
          client.setMode(this.purifierNativeId, preset),
        )
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
    speed: purifier.speedPercent,
    ...(purifier.percentageStep !== undefined ? { percentageStep: purifier.percentageStep } : {}),
    preset: purifier.preset,
    availablePresets: [...purifier.availablePresets],
    direction: null,
    oscillating: null,
    lastChangedAt: now,
  }
}
