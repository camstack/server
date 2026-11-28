import {
  BaseDevice,
  type DeviceContext,
  type DeviceFeature,
  errMsg,
  type InferNativeProvider,
  type SwitchStatus,
  switchCapability,
} from '@dominevo/types'
import { vesyncToggleSchema, type VeSyncToggleKind } from '../config.js'
import type { VeSyncClient, VeSyncDeviceSnapshot } from '../vesync-client-contract.js'
import { vesyncAccounts } from '../vesync-account-resolver.js'
import { registerVeSyncStateRefresh } from './vesync-state-refresh.js'

const SWITCH_CAP = switchCapability.name
const COLD_START: SwitchStatus = { on: false, lastChangedAt: 0 }

/**
 * One VeSync boolean toggle (`child-lock` or `display`) as a Dominevo
 * {@link import('@dominevo/types').DeviceType.Switch} accessory child of a purifier
 * (both toggles) or a humidifier (`display` only — tsvesync drives no humidifier child
 * lock). Registers ONE cap (`switch`). `purifierNativeId` is the parent's VeSync cid,
 * whatever its kind (the field keeps its first name so stored children still parse).
 *
 * A device can register the `switch` cap only ONCE, so child-lock and display
 * are modelled as two SEPARATE Switch accessory children rather than extra
 * `switch` caps on the Fan. `kind` selects which live-client toggle this child
 * drives and which snapshot field it mirrors.
 *
 * The slice is fed from the live device snapshot on each poll tick and after each
 * command's refresh (seeded cold on activate). Commands go through the account
 * manager's `runCommand`.
 */
export class VeSyncToggleDevice extends BaseDevice<typeof vesyncToggleSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly kind: VeSyncToggleKind
  private readonly purifierNativeId: string
  private readonly integrationId: string

  private snapshotUnsub: (() => void) | null = null
  /** Stops the core state refresh's re-registration (D1062). */
  private stopStateRefresh: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = vesyncToggleSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, vesyncToggleSchema, { type: ctx.deviceMeta.type })
    this.kind = cfg.kind
    this.purifierNativeId = cfg.purifierNativeId
    this.integrationId = cfg.integrationId
    this.online =
      vesyncAccounts.getDevice(this.integrationId, this.purifierNativeId)?.online ?? false
    void this.updateSourceInfo({
      id: `${this.integrationId}:${this.purifierNativeId}:${this.kind}`,
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
    this.registerSwitchCap()
    this.runtimeState.setCapState(SWITCH_CAP, COLD_START)
    this.attachSnapshotListener()
    this.recomputeSlice()
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

  private attachSnapshotListener(): void {
    const onSnapshot = (): void => {
      try {
        this.recomputeSlice()
      } catch (err) {
        this.ctx.logger.warn('vesync toggle: snapshot handler error', {
          tags: { deviceId: this.id },
          meta: { kind: this.kind, error: errMsg(err) },
        })
      }
    }
    this.snapshotUnsub = vesyncAccounts.onSnapshot(this.integrationId, onSnapshot)
  }

  /** Recompute + write this toggle's `switch` cap slice from the live snapshot. */
  private recomputeSlice(): void {
    const device = vesyncAccounts.getDevice(this.integrationId, this.purifierNativeId)
    if (device === null) return
    if (this.online !== device.online) this.markOnline(device.online)
    const on = this.readToggle(device)
    this.runtimeState.setCapState(SWITCH_CAP, { on, lastChangedAt: Date.now() })
  }

  private readToggle(device: VeSyncDeviceSnapshot): boolean {
    if (this.kind === 'display') return device.display
    return device.kind === 'purifier' ? device.childLock : false
  }

  /** Send one command through the account manager; the core re-reads the device after it (D1062). */
  private async command(name: string, run: (client: VeSyncClient) => Promise<void>): Promise<void> {
    const manager = vesyncAccounts.getManager(this.integrationId)
    if (manager === null) {
      throw new Error(`VeSync toggle ${this.kind}: account ${this.integrationId} is not available`)
    }
    await manager.runCommand({ nativeId: this.purifierNativeId, deviceId: this.id, name, run })
  }

  private registerSwitchCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => this.runtimeState.getCapState<SwitchStatus>(SWITCH_CAP) ?? COLD_START,
      setState: async ({ on }) => {
        const state = on ? 'on' : 'off'
        if (this.kind === 'child-lock') {
          await this.command(`setChildLock(${state})`, (client) =>
            client.setChildLock(this.purifierNativeId, on),
          )
        } else {
          await this.command(`setDisplay(${state})`, (client) =>
            client.setDisplay(this.purifierNativeId, on),
          )
        }
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
  }
}
