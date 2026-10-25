import { type AcDevice, getAcCapabilities } from '@apocaliss92/nodegree'
import {
  BaseDevice,
  type ClimateControlStatus,
  climateControlCapability,
  type ConfigField,
  type ConfigUISchema,
  type ConfigUISchemaWithValues,
  type DeviceContext,
  DeviceFeature,
  errMsg,
  type FanControlStatus,
  fanControlCapability,
  hydrateSchema,
  type InferNativeProvider,
} from '@camstack/types'
import { z } from 'zod'
import {
  ADVERTISED_CAP_MODES,
  boolToHorizontalSwing,
  boolToVerticalSwing,
  capModeToLibMode,
  fanModeToFanSpeed,
  fanSpeedToFanMode,
  fanSpeedToPercentage,
  GREE_FAN_MODES,
  GREE_FAN_PERCENTAGE_STEP,
  GREE_MAX_TEMP,
  GREE_MIN_TEMP,
  GREE_TEMP_STEP,
  GREE_PRESETS,
  SUPPORTED_CAP_MODES,
  horizontalSwingToBool,
  libModeToCapMode,
  percentageToFanSpeed,
  presetFromFlags,
  presetToFlagWrites,
  verticalSwingToBool,
} from '../gree-domain-mapping.js'
import { greeConnections } from '../gree-gateway.js'

const CLIMATE_CAP = 'climate-control'
const FAN_CAP = 'fan-control'

const CLIMATE_COLD_START: ClimateControlStatus = {
  mode: 'off',
  availableModes: [...ADVERTISED_CAP_MODES],
  fanMode: '',
  availableFanModes: [...GREE_FAN_MODES],
  preset: '',
  availablePresets: [...GREE_PRESETS],
  target: null,
  targetHigh: null,
  targetLow: null,
  targetHumidity: null,
  currentTemp: null,
  currentHumidity: null,
  swingVertical: null,
  swingHorizontal: null,
  minTemp: GREE_MIN_TEMP,
  maxTemp: GREE_MAX_TEMP,
  tempStep: GREE_TEMP_STEP,
  lastFetchedAt: 0,
}

const FAN_COLD_START: FanControlStatus = {
  percentage: null,
  preset: '',
  availablePresets: [],
  direction: null,
  oscillating: null,
  lastChangedAt: 0,
}

/**
 * Persisted config every Gree AC accessory child carries. `greeMac` resolves the
 * bound handle from the connection resolver; `connectionKey` selects the parent
 * AC device's live connection (its own stableId); `system`/`integrationId` are
 * provenance.
 */
export const greeAcSchema = z.object({
  greeMac: z.string().min(1).describe('Gree AC MAC address'),
  connectionKey: z.string().min(1).describe('Per-device connection resolver key'),
  system: z.literal('gree').optional(),
  integrationId: z.string().optional(),
  /** Operator filter — HVAC modes exposed in the control UI (subset of the
   *  model's supported modes). Empty / omitted ⇒ expose all. `off` is always
   *  exposed (power). */
  enabledModes: z.array(z.string()).optional(),
  /** Operator filter — fan speeds exposed in the control UI (subset of
   *  `GREE_FAN_MODES`). Empty / omitted ⇒ expose all. */
  enabledFanModes: z.array(z.string()).optional(),
  /** Operator filter — expose the vertical-swing toggle. Default true. */
  exposeVerticalSwing: z.boolean().optional(),
  /** Operator filter — expose the horizontal-swing toggle (model-permitting).
   *  Default true. */
  exposeHorizontalSwing: z.boolean().optional(),
})

export type GreeAcConfig = z.infer<typeof greeAcSchema>

/**
 * One Gree air conditioner as a CamStack `Thermostat`-type accessory child.
 * Registers `climate-control` (power via mode=`off`, heat/cool/auto/dry/fan_only,
 * target temp, current temp) and `fan-control` (fan speed → percentage, swing →
 * oscillating). Maps the library `AcDevice` getters → the two cap slices on every
 * `stateChanged` push (and seeds on activate).
 *
 * Climate commands route to the bound handle: setMode `off`→`setPower(false)`,
 * any other→`setPower(true)`+`setMode()`; setTarget→`setTargetTemperature()`;
 * setFanMode→`setFanSpeed()` (climate `fanMode` string ↔ Gree speed); setPreset→
 * the comfort-flag setters (turbo/quiet/sleep/eco/8c_heat → `setTurbo`/`setQuiet`/
 * `setSleep`/`setPowerSave`/`setSteadyHeat`, exclusive); setSwingVertical /
 * setSwingHorizontal → `setSwingVertical`/`setSwingHorizontal(FullSwing|Default)`
 * (two independent booleans on the climate entity). Fan commands:
 * setPercentage→`setFanSpeed()` (percentage↔FanSpeed bucket). Swing is NOT on the
 * fan entity — `setOscillating` throws (swing lives on `climate-control`).
 *
 * The panel-light / X-Fan / health / fresh-air boolean flags are exposed as
 * separate `DeviceType.Switch` accessory children (see `GreeToggleDevice`),
 * mirroring the HA Gree integration — they are NOT on this entity.
 *
 * TODO (deferred — needs protocol RE / live confirmation): `heat_cool`
 * dual-setpoint (Gree single-setpoint ACs have none), `setTargetHumidity`
 * (`Dwet`/`DwatSen` dehumidifier props exist in PROPS but the library exposes no
 * getter/setter yet), and the fine-grained 12-position vertical / 7-position
 * horizontal swing (collapsed to two booleans — a vendor swing-position cap
 * would carry the discrete positions).
 */
export class GreeAcDevice extends BaseDevice<typeof greeAcSchema> {
  /**
   * Feature flags derived from the live AC capabilities. Implemented as a getter
   * (satisfies the abstract `readonly features` on BaseDevice) so the
   * capability-gated horizontal-swing flag tracks the resolved handle as it
   * binds, without a stale constructor-time snapshot. Fan-mode, preset and
   * vertical-swing are universal on Gree ACs and always advertised.
   */
  override get features(): readonly DeviceFeature[] {
    const caps = this.resolveAc()?.capabilities ?? getAcCapabilities()
    const cfg = this.config.values
    const flags: DeviceFeature[] = [DeviceFeature.ClimateFanMode, DeviceFeature.ClimatePreset]
    if (cfg.exposeVerticalSwing ?? true) flags.push(DeviceFeature.ClimateSwingVertical)
    if (caps.horizontalSwing && (cfg.exposeHorizontalSwing ?? true)) {
      flags.push(DeviceFeature.ClimateSwingHorizontal)
    }
    return flags
  }

  private readonly greeMac: string
  private readonly connectionKey: string
  private stateChangedUnsub: (() => void) | null = null
  private surfaceUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const persisted = greeAcSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, greeAcSchema, { type: ctx.deviceMeta.type })
    this.greeMac = persisted.greeMac
    this.connectionKey = persisted.connectionKey
    this.online = true
    void this.updateSourceInfo({ id: this.greeMac, system: 'gree' })
  }

  private resolveAc(): AcDevice | null {
    return greeConnections.getDevice(this.connectionKey, this.greeMac)
  }

  private requireAc(): AcDevice {
    const ac = this.resolveAc()
    if (ac === null) {
      throw new Error(`GreeAcDevice: AC handle unavailable (mac=${this.greeMac})`)
    }
    return ac
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerCaps()
    this.attachStateListener()
    this.recomputeSlices()
    // The bound handle may not exist yet at activate (restore races the parent's
    // async bind). Re-attach + reseed whenever the connection surface is
    // (re)published so the climate slice never stays frozen at cold-start.
    this.surfaceUnsub = greeConnections.onSurface(this.connectionKey, () => {
      this.attachStateListener()
      this.recomputeSlices()
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

  /** Attach the live `stateChanged` listener to the bound AC handle. Idempotent:
   *  drops any prior listener first, so it is safe to call on every surface
   *  (re)publish. No-op until the handle is actually bound. */
  private attachStateListener(): void {
    const ac = this.resolveAc()
    if (!ac) {
      this.ctx.logger.debug('GreeAcDevice: handle not present; no live listener yet', {
        meta: { greeMac: this.greeMac },
      })
      return
    }
    this.detachStateListener()
    const onState = (): void => {
      try {
        this.recomputeSlices()
      } catch (err) {
        this.ctx.logger.warn('gree ac: stateChanged handler error', {
          meta: { greeMac: this.greeMac, error: errMsg(err) },
        })
      }
    }
    ac.on('stateChanged', onState)
    this.stateChangedUnsub = (): void => {
      ac.off('stateChanged', onState)
    }
  }

  private registerCaps(): void {
    const climateProvider: InferNativeProvider<typeof climateControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<ClimateControlStatus>(CLIMATE_CAP) ??
        this.applyClimateFilters(CLIMATE_COLD_START),
      setMode: async ({ mode }) => {
        const ac = this.requireAc()
        const libMode = capModeToLibMode(mode)
        if (libMode === null) {
          if (mode === 'off') {
            await ac.setPower(false)
            return
          }
          throw new Error(`gree ac: unsupported mode "${mode}"`)
        }
        if (!ac.power) await ac.setPower(true)
        await ac.setMode(libMode)
      },
      setFanMode: async ({ fanMode }) => {
        const speed = fanModeToFanSpeed(fanMode)
        if (speed === null) {
          throw new Error(`gree ac: unsupported fan mode "${fanMode}"`)
        }
        await this.requireAc().setFanSpeed(speed)
      },
      setPreset: async ({ preset }) => {
        const writes = presetToFlagWrites(preset)
        if (writes === null) {
          throw new Error(`gree ac: unsupported preset "${preset}"`)
        }
        const ac = this.requireAc()
        // Apply only the flags that actually change, so a no-op preset switch
        // doesn't fire five redundant UDP commands. Each flag is an independent
        // device toggle (Tur/Quiet/SwhSlp/SvSt/StHt); selecting one clears the
        // rest to keep the cap's single-active-preset model coherent.
        if (ac.turbo !== writes.turbo) await ac.setTurbo(writes.turbo)
        if (ac.quiet !== writes.quiet) await ac.setQuiet(writes.quiet)
        if (ac.sleep !== writes.sleep) await ac.setSleep(writes.sleep)
        if (ac.powerSave !== writes.powerSave) await ac.setPowerSave(writes.powerSave)
        if (ac.steadyHeat !== writes.steadyHeat) await ac.setSteadyHeat(writes.steadyHeat)
      },
      setTarget: async ({ target }) => {
        await this.requireAc().setTargetTemperature(target)
      },
      setTargetRange: async ({ targetLow, targetHigh }) => {
        throw new Error(`gree ac: dual setpoint not supported (got ${targetLow}..${targetHigh})`)
      },
      setTargetHumidity: async ({ targetHumidity }) => {
        throw new Error(`gree ac: target humidity not supported (got ${targetHumidity})`)
      },
      setSwingVertical: async ({ on }) => {
        await this.requireAc().setSwingVertical(boolToVerticalSwing(on))
      },
      setSwingHorizontal: async ({ on }) => {
        const ac = this.requireAc()
        if (!ac.capabilities.horizontalSwing) {
          throw new Error('gree ac: horizontal swing not supported on this model')
        }
        await ac.setSwingHorizontal(boolToHorizontalSwing(on))
      },
    }
    this.ctx.registerNativeCap(climateControlCapability, climateProvider)
    this.runtimeState.setCapState(CLIMATE_CAP, this.applyClimateFilters(CLIMATE_COLD_START))

    const fanProvider: InferNativeProvider<typeof fanControlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<FanControlStatus>(FAN_CAP) ?? FAN_COLD_START,
      setPercentage: async ({ percentage }) => {
        await this.requireAc().setFanSpeed(percentageToFanSpeed(percentage))
      },
      setPreset: async ({ preset }) => {
        throw new Error(`gree ac: fan presets not yet supported (got "${preset}")`)
      },
      setDirection: async ({ direction }) => {
        throw new Error(`gree ac: fan direction not supported (got "${direction}")`)
      },
      setOscillating: async ({ oscillating }) => {
        throw new Error(
          `gree ac: swing is exposed on climate-control; use setSwingVertical/setSwingHorizontal (got oscillating=${oscillating})`,
        )
      },
    }
    this.ctx.registerNativeCap(fanControlCapability, fanProvider)
    this.runtimeState.setCapState(FAN_CAP, FAN_COLD_START)
  }

  private recomputeSlices(): void {
    const ac = this.resolveAc()
    if (ac === null) return
    const now = Date.now()

    const mode = ac.power ? libModeToCapMode(ac.mode) : 'off'
    const preset = presetFromFlags({
      turbo: ac.turbo,
      quiet: ac.quiet,
      sleep: ac.sleep,
      powerSave: ac.powerSave,
      steadyHeat: ac.steadyHeat,
    })
    const climateSlice: ClimateControlStatus = {
      mode,
      availableModes: [...ADVERTISED_CAP_MODES],
      fanMode: fanSpeedToFanMode(ac.fanSpeed),
      availableFanModes: [...GREE_FAN_MODES],
      preset,
      availablePresets: [...GREE_PRESETS],
      target: ac.targetTemperature,
      targetHigh: null,
      targetLow: null,
      targetHumidity: null,
      currentTemp: ac.currentTemperature ?? null,
      currentHumidity: null,
      swingVertical: verticalSwingToBool(ac.swingVertical),
      swingHorizontal: ac.capabilities.horizontalSwing
        ? horizontalSwingToBool(ac.swingHorizontal)
        : null,
      minTemp: GREE_MIN_TEMP,
      maxTemp: GREE_MAX_TEMP,
      tempStep: GREE_TEMP_STEP,
      lastFetchedAt: now,
    }
    this.runtimeState.setCapState(CLIMATE_CAP, this.applyClimateFilters(climateSlice))

    const fanSlice: FanControlStatus = {
      percentage: fanSpeedToPercentage(ac.fanSpeed),
      percentageStep: GREE_FAN_PERCENTAGE_STEP,
      preset: '',
      availablePresets: [],
      direction: null,
      // Swing now lives exclusively on the climate entity as two independent
      // booleans; the fan entity no longer mirrors it.
      oscillating: null,
      lastChangedAt: now,
    }
    this.runtimeState.setCapState(FAN_CAP, fanSlice)
  }

  /**
   * Apply the operator's per-AC exposure filters to a climate slice: narrow
   * `availableModes` / `availableFanModes` to the enabled subsets (empty ⇒ all;
   * `off` is always kept) and null out a swing axis the operator has hidden.
   * Pure — returns a new slice, never mutates the input.
   */
  private applyClimateFilters(slice: ClimateControlStatus): ClimateControlStatus {
    const cfg = this.config.values
    const enabledModes = cfg.enabledModes
    const enabledFanModes = cfg.enabledFanModes
    const exposeV = cfg.exposeVerticalSwing ?? true
    const exposeH = cfg.exposeHorizontalSwing ?? true

    const availableModes =
      enabledModes && enabledModes.length > 0
        ? slice.availableModes.filter((m) => m === 'off' || enabledModes.includes(m))
        : slice.availableModes
    const availableFanModes =
      enabledFanModes && enabledFanModes.length > 0
        ? slice.availableFanModes.filter((f) => enabledFanModes.includes(f))
        : slice.availableFanModes

    return {
      ...slice,
      availableModes,
      availableFanModes,
      swingVertical: exposeV ? slice.swingVertical : null,
      swingHorizontal: exposeH ? slice.swingHorizontal : null,
    }
  }

  /**
   * Per-AC exposure form (device-details settings). Lets the operator pick
   * which modes / fan speeds / swing axes appear in the AC control UI. An empty
   * multiselect means "expose all". The horizontal-swing toggle is only offered
   * when the model advertises horizontal swing.
   */
  override getSettingsUISchema(): ConfigUISchemaWithValues {
    const supportsHSwing = (this.resolveAc()?.capabilities ?? getAcCapabilities()).horizontalSwing
    const cfg = this.config.values

    const fields: ConfigField[] = [
      {
        type: 'multiselect',
        key: 'enabledModes',
        label: 'Modes',
        labelKey: 'provider-gree:fields.enabledModes.label',
        description: 'Modes shown in the control UI. Empty = all. “Off” is always available.',
        descriptionKey: 'provider-gree:fields.enabledModes.description',
        options: SUPPORTED_CAP_MODES.map((m) => ({ value: m, label: titleCase(m) })),
      },
      {
        type: 'multiselect',
        key: 'enabledFanModes',
        label: 'Fan speeds',
        labelKey: 'provider-gree:fields.enabledFanModes.label',
        description: 'Fan speeds shown in the control UI. Empty = all.',
        descriptionKey: 'provider-gree:fields.enabledFanModes.description',
        options: GREE_FAN_MODES.map((f) => ({ value: f, label: titleCase(f) })),
      },
      {
        type: 'boolean',
        style: 'switch',
        key: 'exposeVerticalSwing',
        label: 'Vertical swing',
        labelKey: 'provider-gree:fields.exposeVerticalSwing.label',
        default: true,
      },
    ]
    if (supportsHSwing) {
      fields.push({
        type: 'boolean',
        style: 'switch',
        key: 'exposeHorizontalSwing',
        label: 'Horizontal swing',
        labelKey: 'provider-gree:settingsUI.exposeHorizontalSwing.label',
        default: true,
      })
    }

    const schema: ConfigUISchema = {
      sections: [
        {
          id: 'exposure',
          title: 'Exposed controls',
          titleKey: 'provider-gree:schema.s_exposure.title',
          fields,
        },
      ],
    }
    return hydrateSchema(schema, {
      enabledModes: cfg.enabledModes ?? [],
      enabledFanModes: cfg.enabledFanModes ?? [],
      exposeVerticalSwing: cfg.exposeVerticalSwing ?? true,
      exposeHorizontalSwing: cfg.exposeHorizontalSwing ?? true,
    })
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    const typed = greeAcSchema.partial().parse(patch)
    await this.config.setAll(typed)
    // Reflect the new exposure immediately: re-emit the filtered climate slice
    // (the live status is what the UI gates swing on) and re-register so the
    // persisted device-meta `features` drop the now-hidden swing axis too
    // (otherwise `getDevice`/`listAll` keep advertising the stale feature).
    this.recomputeSlices()
    await this.refreshFeatures()
  }
}

/** 'fan_only' → 'Fan only', 'medium_low' → 'Medium low'. Pure. */
function titleCase(value: string): string {
  const spaced = value.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
