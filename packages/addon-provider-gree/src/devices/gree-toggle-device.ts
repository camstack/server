import type { AcDevice } from '@apocaliss92/nodegree'
import {
  BaseDevice,
  type DeviceContext,
  type DeviceFeature,
  errMsg,
  type InferNativeProvider,
  type SwitchStatus,
  switchCapability,
} from '@camstack/types'
import { z } from 'zod'
import { greeConnections } from '../gree-gateway.js'

const SWITCH_CAP = 'switch'

const SWITCH_COLD_START: SwitchStatus = { on: false, lastChangedAt: 0 }

/**
 * The four independent boolean device flags a Gree AC exposes that HA surfaces
 * as separate switch entities (panel light / X-Fan / health-ion / fresh-air).
 * Each maps 1:1 to a library getter + setter pair on {@link AcDevice}.
 */
export type GreeToggleKind = 'light' | 'xfan' | 'health' | 'freshAir'

export const GREE_TOGGLE_KINDS: readonly GreeToggleKind[] = ['light', 'xfan', 'health', 'freshAir']

/**
 * Persisted config every Gree toggle accessory child carries. Mirrors
 * {@link greeAcSchema}: `greeMac` resolves the bound handle, `connectionKey`
 * selects the parent AC device's live connection, `system`/`integrationId` are
 * provenance. `toggle` selects which of the four boolean device flags this child
 * drives.
 */
export const greeToggleSchema = z.object({
  toggle: z.enum(['light', 'xfan', 'health', 'freshAir']).describe('Which Gree boolean flag'),
  greeMac: z.string().min(1).describe('Gree AC MAC address'),
  connectionKey: z.string().min(1).describe('Per-device connection resolver key'),
  system: z.literal('gree').optional(),
  integrationId: z.string().optional(),
})

export type GreeToggleConfig = z.infer<typeof greeToggleSchema>

/**
 * One Gree boolean device flag (panel light / X-Fan / health / fresh-air) as a
 * `DeviceType.Switch` accessory child, mirroring the HA Gree integration which
 * exposes each as its own switch entity. Registers the generic `switch` cap;
 * `setState` routes to the matching library setter, and a `stateChanged`
 * listener re-derives the slice from the matching getter on every push.
 *
 * Follows the {@link GreeAcDevice} lifecycle exactly: `onActivate` registers the
 * cap + attaches the listener + seeds the slice; `removeDevice` unsubscribes.
 */
export class GreeToggleDevice extends BaseDevice<typeof greeToggleSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly toggle: GreeToggleKind
  private readonly greeMac: string
  private readonly connectionKey: string
  private stateChangedUnsub: (() => void) | null = null
  private surfaceUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const persisted = greeToggleSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, greeToggleSchema, { type: ctx.deviceMeta.type })
    this.toggle = persisted.toggle
    this.greeMac = persisted.greeMac
    this.connectionKey = persisted.connectionKey
    this.online = true
    void this.updateSourceInfo({ id: `${this.greeMac}:${this.toggle}`, system: 'gree' })
  }

  private resolveAc(): AcDevice | null {
    return greeConnections.getDevice(this.connectionKey, this.greeMac)
  }

  private requireAc(): AcDevice {
    const ac = this.resolveAc()
    if (ac === null) {
      throw new Error(
        `GreeToggleDevice: AC handle unavailable (mac=${this.greeMac}, toggle=${this.toggle})`,
      )
    }
    return ac
  }

  /** Read the current value of the configured boolean flag from a live handle. */
  private readFlag(ac: AcDevice): boolean {
    switch (this.toggle) {
      case 'light':
        return ac.light
      case 'xfan':
        return ac.xfan
      case 'health':
        return ac.health
      case 'freshAir':
        return ac.freshAir
    }
  }

  /** Apply a new value to the configured boolean flag via the library setter. */
  private async writeFlag(ac: AcDevice, on: boolean): Promise<void> {
    switch (this.toggle) {
      case 'light':
        await ac.setLight(on)
        return
      case 'xfan':
        await ac.setXfan(on)
        return
      case 'health':
        await ac.setHealth(on)
        return
      case 'freshAir':
        await ac.setFreshAir(on)
        return
    }
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerCap()
    this.attachStateListener()
    this.recomputeSlice()
    // Re-attach + reseed when the bound handle is (re)published — the child can
    // activate before the parent's async bind completes (see GreeAcDevice).
    this.surfaceUnsub = greeConnections.onSurface(this.connectionKey, () => {
      this.attachStateListener()
      this.recomputeSlice()
    })
  }

  override async removeDevice(): Promise<void> {
    this.detachStateListener()
    if (this.surfaceUnsub) {
      try {
        this.surfaceUnsub()
      } catch {
        /* best-effort */
      }
      this.surfaceUnsub = null
    }
  }

  private detachStateListener(): void {
    if (this.stateChangedUnsub) {
      try {
        this.stateChangedUnsub()
      } catch {
        // best-effort — device is being torn down regardless
      }
      this.stateChangedUnsub = null
    }
  }

  private attachStateListener(): void {
    const ac = this.resolveAc()
    if (!ac) {
      this.ctx.logger.debug('GreeToggleDevice: handle not present; no live listener yet', {
        meta: { greeMac: this.greeMac, toggle: this.toggle },
      })
      return
    }
    this.detachStateListener()
    const onState = (): void => {
      try {
        this.recomputeSlice()
      } catch (err) {
        this.ctx.logger.warn('gree toggle: stateChanged handler error', {
          meta: { greeMac: this.greeMac, toggle: this.toggle, error: errMsg(err) },
        })
      }
    }
    ac.on('stateChanged', onState)
    this.stateChangedUnsub = (): void => {
      ac.off('stateChanged', onState)
    }
  }

  private registerCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<SwitchStatus>(SWITCH_CAP) ?? SWITCH_COLD_START,
      setState: async ({ on }) => {
        const ac = this.requireAc()
        await this.writeFlag(ac, on)
        this.runtimeState.setCapState(SWITCH_CAP, { on, lastChangedAt: Date.now() })
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    this.runtimeState.setCapState(SWITCH_CAP, SWITCH_COLD_START)
  }

  private recomputeSlice(): void {
    const ac = this.resolveAc()
    if (ac === null) return
    const on = this.readFlag(ac)
    const current = this.runtimeState.getCapState<SwitchStatus>(SWITCH_CAP)
    if (current?.on === on) return
    this.runtimeState.setCapState(SWITCH_CAP, { on, lastChangedAt: Date.now() })
  }
}
