import type { BaseDevice as DreameBaseDevice } from '@apocaliss92/nodedreame'
import {
  BaseDevice,
  type DeviceContext,
  type DeviceFeature,
  type DeviceRole,
  errMsg,
} from '@camstack/types'
import { z } from 'zod'
import { dreameFacades } from '../dreame-gateway.js'

/**
 * Persisted config every Dreame accessory child carries. `dreameDeviceId`
 * resolves the live handle from the facade; `brokerId` selects the account;
 * `model` is the cloud model string; `system`/`integrationId` are provenance.
 */
export const dreameChildSchema = z.object({
  dreameDeviceId: z.string().min(1).describe('Dreame cloud device id (did)'),
  brokerId: z.string().min(1).describe('Registry broker id'),
  model: z.string().optional().describe('Dreame cloud model string'),
  system: z.literal('dreame').optional(),
  integrationId: z.string().optional(),
  // Map-style customization — read ONLY by the map Image child to build the
  // renderer options (mirrors the HA integration's color_scheme / feature
  // toggles). Optional everywhere; non-map children never set or surface them.
  // Only node-dreame's own schemes are offered now; a legacy persisted value
  // (e.g. the old 'dreame-light' default) is coerced away via `.catch` so an
  // existing device config still parses (the renderer also falls back to flat).
  mapColorScheme: z.enum(['flat', 'dark-neon', 'materico']).catch('flat').optional(),
  mapShowPath: z.boolean().optional(),
  mapShowRobot: z.boolean().optional(),
  mapShowCharger: z.boolean().optional(),
  /**
   * `navigation` per-device overrides (camera child only): a feature flag set
   * here wins over the addon defaults, an entry id listed here is switched off.
   * Data, not code — see `dreame-navigation-config.ts`.
   */
  navigationFeatures: z
    .object({
      move: z.boolean().optional(),
      stop: z.boolean().optional(),
      goToPoint: z.boolean().optional(),
      runAction: z.boolean().optional(),
      playSound: z.boolean().optional(),
      light: z.boolean().optional(),
      lightMode: z.boolean().optional(),
    })
    .optional(),
  navigationDisabledEntryIds: z.array(z.string()).optional(),
  /** Privacy PIN set at pairing — required to wake a coded camera (camera child only). */
  navigationAccessCode: z.string().optional().meta({ secret: true }),
  /**
   * The video backend the robot should sit on (camera child only).
   *
   * Not a preference the addon enforces: it is written THROUGH to the device
   * by `applySettingsPatch`, and the device is the authority on where it
   * actually is. Stored so the settings form has a value to show before the
   * first read answers.
   */
  videoVendor: z.enum(['ali', 'tx']).optional(),
  /**
   * ms-epoch of the ONE-SHOT recording seed (camera child only, D380).
   *
   * A MARK, never the value: it says this camera was seeded, which stays true
   * after the operator switches recording off — and an operator's `off` is
   * byte-identical to a camera that was never seeded (`enabled: false,
   * bands: []`), so nothing but this field can tell the two apart. The
   * authority for what is recorded remains `RecordingConfig` (D62).
   */
  recordingSeededAt: z.number().optional(),
  mapShowNoGo: z.boolean().optional(),
  mapShowVirtualWalls: z.boolean().optional(),
  mapShowObstacles: z.boolean().optional(),
  mapShowSegmentLabels: z.boolean().optional(),
  mapShowSegmentNames: z.boolean().optional(),
  mapColorObstaclesByType: z.boolean().optional(),
  mapShowFurniture: z.boolean().optional(),
  mapShowCleanedArea: z.boolean().optional(),
})

export type DreameChildConfig = z.infer<typeof dreameChildSchema>

/**
 * Shared base for every Dreame accessory child (vacuum / mower). Holds the
 * dreameDeviceId + brokerId resolved from config and the facade-resolution
 * seam. Concrete subclasses register their control cap + attach a
 * `stateChanged` listener that recomputes their cap slice.
 *
 * Cap registration + the device's MQTT push lifecycle are wired in `onActivate`
 * (mirrors `HaBaseChildDevice`) so `registerNativeCap` lands AFTER the device is
 * registered with the kernel. The library opens the device's MQTT push during
 * `discoverDevices()` (called by the integration manager), so the live handle is
 * already streaming by the time this child activates.
 */
export abstract class DreameChildDevice extends BaseDevice<typeof dreameChildSchema> {
  readonly features: readonly DeviceFeature[] = []

  /** Dreame cloud device id — dispatch + event-filter key. */
  protected readonly dreameDeviceId: string
  /** Registry broker id selecting the account facade. */
  protected readonly brokerId: string
  /** Cloud model string (e.g. `dreame.vacuum.r2228`). */
  protected readonly model: string | undefined

  /** Disposer for the facade `stateChanged` listener. */
  private stateChangedUnsub: (() => void) | null = null

  protected constructor(ctx: DeviceContext, role?: DeviceRole) {
    const persisted = dreameChildSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, dreameChildSchema, {
      type: ctx.deviceMeta.type,
      ...(role !== undefined ? { role } : {}),
    })
    this.dreameDeviceId = persisted.dreameDeviceId
    this.brokerId = persisted.brokerId
    this.model = persisted.model
    // online IS the live cloud link (D62): reachable now, and flipped on every
    // integration connect / disconnect (addon.setIntegrationDevicesOnline).
    this.online = dreameFacades.getDevice(this.brokerId, this.dreameDeviceId) !== null
    void this.updateSourceInfo({ id: this.dreameDeviceId, system: 'dreame' })
  }

  /** Resolve this child's live Dreame device handle, or null when disconnected. */
  protected resolveHandle(): DreameBaseDevice | null {
    return dreameFacades.getDevice(this.brokerId, this.dreameDeviceId)
  }

  /** Narrow the optional handle to a present one or throw a clear error. */
  protected requireHandle(): DreameBaseDevice {
    const handle = this.resolveHandle()
    if (!handle) {
      throw new Error(
        `DreameChildDevice: cloud connection unavailable (device=${this.dreameDeviceId})`,
      )
    }
    return handle
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // Register the control cap + seed the cold-start slice, THEN attach the
    // live `stateChanged` listener and replay the current cached values so the
    // slice reflects reality without waiting for the next push.
    this.registerControlCap()
    this.attachStateListener()
    this.recomputeSlice()
  }

  override async removeDevice(): Promise<void> {
    if (this.stateChangedUnsub) {
      try {
        this.stateChangedUnsub()
      } catch {
        // best-effort — device is being torn down regardless
      }
      this.stateChangedUnsub = null
    }
  }

  /** Subscribe to this device's state pushes (recompute this child's slice).
   *  Uses the resolver's shared fan-out bus rather than the device handle's
   *  EventEmitter directly, so N children on one robot never trip Node's
   *  MaxListeners cap. Works even before the facade exists — `recomputeSlice`
   *  reads through `resolveHandle()` and replays once pushes arrive. */
  private attachStateListener(): void {
    // Defensive: a repeated activation must replace (not stack) the listener.
    this.stateChangedUnsub?.()
    const onState = (): void => {
      try {
        this.recomputeSlice()
      } catch (err) {
        this.ctx.logger.warn('dreame child: stateChanged handler error', {
          tags: { deviceId: this.id },
          meta: { dreameDeviceId: this.dreameDeviceId, error: errMsg(err) },
        })
      }
    }
    this.stateChangedUnsub = dreameFacades.onStateChanged(
      this.brokerId,
      this.dreameDeviceId,
      onState,
    )
  }

  /** Register the device-scoped control cap (subclass-specific). */
  protected abstract registerControlCap(): void

  /** Recompute + write this child's cap slice from the live handle getters.
   *  Called on activation (seed) and on every `stateChanged` push. */
  protected abstract recomputeSlice(): void
}
