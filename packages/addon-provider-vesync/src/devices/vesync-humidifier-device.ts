import {
  type AccessoryChildSpec,
  BaseDevice,
  type DeviceContext,
  type DeviceFeature,
  DeviceRole,
  DeviceType,
  errMsg,
  humidifierCapability,
  type HumidifierStatus,
  type IDevice,
  type InferNativeProvider,
} from '@camstack/types'
import { vesyncHumidifierSchema, type VeSyncSensorKind, type VeSyncToggleKind } from '../config.js'
import type { VeSyncClient, VeSyncHumidifierSnapshot } from '../vesync-client-contract.js'
import { vesyncAccounts } from '../vesync-account-resolver.js'
import { vesyncIdentifiers } from '../vesync-identifiers.js'
import { VeSyncSensorDevice } from './vesync-sensor-device.js'
import { VeSyncToggleDevice } from './vesync-toggle-device.js'

const HUMIDIFIER_CAP = humidifierCapability.name

const COLD_START: HumidifierStatus = {
  on: false,
  currentHumidity: null,
  targetHumidity: null,
  mode: null,
  availableModes: [],
  action: null,
  minHumidity: null,
  maxHumidity: null,
  lastChangedAt: 0,
}

/** One accessory child the humidifier fans out. */
interface AccessoryPlan {
  readonly suffix: string
  readonly type: DeviceType
  readonly role: DeviceRole
  readonly nameSuffix: string
  readonly config: Record<string, unknown>
  readonly factory: (ctx: DeviceContext) => IDevice
}

/**
 * One VeSync humidifier as a CamStack {@link DeviceType.Humidifier} device, a sibling of
 * the account Gateway. Registers the `humidifier` cap (power, target humidity, mode, the
 * measured humidity) and fans three accessory children out:
 *   - display   → {@link DeviceType.Switch} ({@link VeSyncToggleDevice})
 *   - humidity  → {@link DeviceType.Sensor} ({@link VeSyncSensorDevice}, humidity-sensor)
 *   - water-low → {@link DeviceType.Sensor} ({@link VeSyncSensorDevice}, binary: tank empty)
 *
 * The children carry the humidifier cid in `purifierNativeId` (the name every VeSync
 * accessory config shares). The slice is fed from the live snapshot on each poll tick and
 * after each command's refresh; commands go through the account manager's `runCommand`.
 *
 * Not surfaced: the night light (`setNightLight` exists on the 1000S class only, and a
 * brightness needs a select-style cap), the mist level (no generic cap) and a child lock
 * (tsvesync drives none on a humidifier).
 */
export class VeSyncHumidifierDevice extends BaseDevice<typeof vesyncHumidifierSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly humidifierNativeId: string
  private readonly integrationId: string

  private snapshotUnsub: (() => void) | null = null
  /** The last identity declaration that landed (D1059); an unchanged one is not re-sent. */
  private lastIdentityKey: string | null = null

  constructor(ctx: DeviceContext) {
    const cfg = vesyncHumidifierSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, vesyncHumidifierSchema, { type: DeviceType.Humidifier })
    this.humidifierNativeId = cfg.humidifierNativeId
    this.integrationId = cfg.integrationId
    this.online =
      vesyncAccounts.getHumidifier(this.integrationId, this.humidifierNativeId)?.online ?? false
    this.registerHumidifierCap()
    this.runtimeState.setCapState(HUMIDIFIER_CAP, COLD_START)
    void this.updateSourceInfo({
      id: `${this.integrationId}:${this.humidifierNativeId}`,
      system: 'vesync',
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.attachSnapshotListener()
    this.recomputeSlice()
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

  /** Fan out the fixed accessory children (display switch + humidity / water-low sensors). */
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
      purifierNativeId: this.humidifierNativeId,
      integrationId: this.integrationId,
      system: 'vesync',
    }
    const toggle = (kind: VeSyncToggleKind): Record<string, unknown> => ({ ...base, kind })
    const sensor = (kind: VeSyncSensorKind): Record<string, unknown> => ({ ...base, kind })
    return [
      {
        suffix: 'display',
        type: DeviceType.Switch,
        role: DeviceRole.BinaryHelper,
        nameSuffix: 'Display',
        config: toggle('display'),
        factory: (ctx: DeviceContext): IDevice => new VeSyncToggleDevice(ctx),
      },
      {
        suffix: 'humidity',
        type: DeviceType.Sensor,
        role: DeviceRole.HumiditySensor,
        nameSuffix: 'Humidity',
        config: sensor('humidity'),
        factory: (ctx: DeviceContext): IDevice => new VeSyncSensorDevice(ctx),
      },
      {
        suffix: 'water-low',
        type: DeviceType.Sensor,
        role: DeviceRole.BinarySensor,
        nameSuffix: 'Water tank empty',
        config: sensor('water-low'),
        factory: (ctx: DeviceContext): IDevice => new VeSyncSensorDevice(ctx),
      },
    ]
  }

  private attachSnapshotListener(): void {
    const onSnapshot = (): void => {
      try {
        this.recomputeSlice()
      } catch (err) {
        this.ctx.logger.warn('vesync humidifier: snapshot handler error', {
          tags: { deviceId: this.id },
          meta: { humidifierNativeId: this.humidifierNativeId, error: errMsg(err) },
        })
      }
    }
    this.snapshotUnsub = vesyncAccounts.onSnapshot(this.integrationId, onSnapshot)
  }

  /** Recompute + write the `humidifier` slice from the live snapshot. */
  private recomputeSlice(): void {
    const humidifier = vesyncAccounts.getHumidifier(this.integrationId, this.humidifierNativeId)
    if (humidifier === null) return
    if (this.online !== humidifier.online) this.markOnline(humidifier.online)
    this.runtimeState.setCapState(HUMIDIFIER_CAP, humidifierSlice(humidifier, Date.now()))
    void this.declareIdentity(humidifier)
  }

  /** Declare the cloud cid and the MAC as typed identifiers (D1059), when they changed. */
  private async declareIdentity(humidifier: VeSyncHumidifierSnapshot): Promise<void> {
    const declaration = vesyncIdentifiers(humidifier)
    if (declaration === null) return
    const key = JSON.stringify(declaration)
    if (key === this.lastIdentityKey) return
    this.lastIdentityKey = key
    const result = await this.declareIdentifiers(declaration.identifiers, {
      unread: declaration.unread,
    })
    if (result.outcome !== 'declared') this.lastIdentityKey = null
  }

  /** Send one command through the account manager (it refreshes and pushes afterwards). */
  private async command(name: string, run: (client: VeSyncClient) => Promise<void>): Promise<void> {
    const manager = vesyncAccounts.getManager(this.integrationId)
    if (manager === null) {
      throw new Error(
        `VeSync humidifier ${this.humidifierNativeId}: integration ${this.integrationId} is not available`,
      )
    }
    await manager.runCommand({ nativeId: this.humidifierNativeId, deviceId: this.id, name, run })
  }

  private registerHumidifierCap(): void {
    const provider: InferNativeProvider<typeof humidifierCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<HumidifierStatus>(HUMIDIFIER_CAP) ?? COLD_START,
      setOn: async ({ on }) => {
        await this.command(`setPower(${on ? 'on' : 'off'})`, (client) =>
          client.setPower(this.humidifierNativeId, on),
        )
      },
      setTargetHumidity: async ({ humidity }) => {
        await this.command(`setTargetHumidity(${humidity})`, (client) =>
          client.setTargetHumidity(this.humidifierNativeId, humidity),
        )
      },
      setMode: async ({ mode }) => {
        await this.command(`setMode(${mode})`, (client) =>
          client.setMode(this.humidifierNativeId, mode),
        )
      },
    }
    this.ctx.registerNativeCap(humidifierCapability, provider)
  }
}

/** Map a humidifier snapshot onto the `humidifier` cap status. */
export function humidifierSlice(
  humidifier: VeSyncHumidifierSnapshot,
  now: number,
): HumidifierStatus {
  return {
    on: humidifier.power,
    currentHumidity: humidifier.currentHumidity,
    targetHumidity: humidifier.targetHumidity,
    mode: humidifier.mode !== '' ? humidifier.mode : null,
    availableModes: [...humidifier.availableModes],
    action: null,
    minHumidity: humidifier.minHumidity,
    maxHumidity: humidifier.maxHumidity,
    lastChangedAt: now,
  }
}
