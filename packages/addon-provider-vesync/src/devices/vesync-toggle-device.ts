import {
  BaseDevice,
  type DeviceContext,
  type DeviceFeature,
  errMsg,
  type InferNativeProvider,
  type SwitchStatus,
  switchCapability,
} from '@camstack/types'
import { vesyncToggleSchema, type VeSyncToggleKind } from '../config.js'
import type { VeSyncClient, VeSyncPurifierSnapshot } from '../vesync-client-contract.js'
import { vesyncAccounts } from '../vesync-account-resolver.js'

const SWITCH_CAP = switchCapability.name
const COLD_START: SwitchStatus = { on: false, lastChangedAt: 0 }

/**
 * One VeSync purifier boolean toggle (`child-lock` or `display`) as a CamStack
 * {@link import('@camstack/types').DeviceType.Switch} accessory child of the
 * purifier Fan device. Registers ONE cap (`switch`).
 *
 * A device can register the `switch` cap only ONCE, so child-lock and display
 * are modelled as two SEPARATE Switch accessory children rather than extra
 * `switch` caps on the Fan. `kind` selects which live-client toggle this child
 * drives and which snapshot field it mirrors.
 *
 * The slice is fed from the live purifier snapshot on each poll tick (and seeded
 * cold on activate). Commands are driven through the live client resolved from
 * {@link vesyncAccounts}.
 */
export class VeSyncToggleDevice extends BaseDevice<typeof vesyncToggleSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly kind: VeSyncToggleKind
  private readonly purifierNativeId: string
  private readonly accountId: string

  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = vesyncToggleSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, vesyncToggleSchema, { type: ctx.deviceMeta.type })
    this.kind = cfg.kind
    this.purifierNativeId = cfg.purifierNativeId
    this.accountId = cfg.accountId
    this.online = vesyncAccounts.getPurifier(this.accountId, this.purifierNativeId)?.online ?? false
    void this.updateSourceInfo({
      id: `${this.accountId}:${this.purifierNativeId}:${this.kind}`,
      system: 'vesync',
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerSwitchCap()
    this.runtimeState.setCapState(SWITCH_CAP, COLD_START)
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

  private attachSnapshotListener(): void {
    const onSnapshot = (): void => {
      try {
        this.recomputeSlice()
      } catch (err) {
        this.ctx.logger.warn('vesync toggle: snapshot handler error', {
          meta: { kind: this.kind, error: errMsg(err) },
        })
      }
    }
    this.snapshotUnsub = vesyncAccounts.onSnapshot(this.accountId, onSnapshot)
  }

  /** Recompute + write this toggle's `switch` cap slice from the live snapshot. */
  private recomputeSlice(): void {
    const purifier = vesyncAccounts.getPurifier(this.accountId, this.purifierNativeId)
    if (purifier === null) return
    if (this.online !== purifier.online) this.markOnline(purifier.online)
    const on = this.readToggle(purifier)
    this.runtimeState.setCapState(SWITCH_CAP, { on, lastChangedAt: Date.now() })
  }

  private readToggle(purifier: VeSyncPurifierSnapshot): boolean {
    return this.kind === 'child-lock' ? purifier.childLock : purifier.display
  }

  private resolveClient(): VeSyncClient {
    const client = vesyncAccounts.getManager(this.accountId)?.client ?? null
    if (client === null) {
      throw new Error(
        `VeSync toggle ${this.kind}: account ${this.accountId} client is not available`,
      )
    }
    return client
  }

  private registerSwitchCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => this.runtimeState.getCapState<SwitchStatus>(SWITCH_CAP) ?? COLD_START,
      setState: async ({ on }) => {
        const client = this.resolveClient()
        if (this.kind === 'child-lock') {
          await client.setChildLock(this.purifierNativeId, on)
        } else {
          await client.setDisplay(this.purifierNativeId, on)
        }
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
  }
}
