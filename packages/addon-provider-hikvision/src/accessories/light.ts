/**
 * HikvisionLightAccessory — child IDevice for the on-camera supplemental
 * white-LED spotlight (`/ISAPI/Image/channels/{cam}/supplementLight`).
 *
 * Caps:
 *   - `switch`     — discrete on/off, sends `<supplementLightMode>`
 *                     `=close` for off, `=<configured mode>` for on
 *   - `brightness` — `<whiteLightBrightness>` 0..100; clamped server-
 *                     side, only honoured by firmware when the light
 *                     is currently on
 *
 * State model: switch + brightness live in the runtime-state slice; a
 * 30s background poll re-reads firmware so external changes (mobile
 * app, NVR-shared light config edits) surface in the UI without
 * operator action.
 *
 * Settings:
 *   - `mode`              — which mode the camera should use when
 *                            switching the light "on". Default seeded
 *                            from the parent's probe; the select renders
 *                            the full list of probed modes.
 *   - `defaultBrightness` — brightness applied on switch-on when the
 *                            cap caller doesn't specify one.
 */

import type {
  ConfigUISchema,
  ConfigUISchemaWithValues,
  DeviceContext,
  InferNativeProvider,
} from '@camstack/types'
import {
  BaseDevice,
  type BrightnessStatus,
  brightnessCapability,
  DeviceType,
  hydrateSchema,
  type SwitchStatus,
  switchCapability,
} from '@camstack/types'
import { z } from 'zod'
import { AccessoryKind, type HikvisionAccessoryHost, hikvisionAccessoryBaseSchema } from './base.js'

export const lightAccessorySchema = hikvisionAccessoryBaseSchema.extend({
  kind: z.literal(AccessoryKind.Floodlight),
  /**
   * Mode passed in `<supplementLightMode>` when switching on. Default
   * seeded from the parent's probe; operator can re-pick from the
   * `lightSupportedModes` list in the settings UI.
   */
  mode: z.string().default('colorVuWhiteLight'),
  /**
   * Brightness (`<whiteLightBrightness>`) applied at switch-on when
   * the brightness cap hasn't been explicitly set yet. 0..100 clamp.
   */
  defaultBrightness: z.number().int().min(0).max(100).default(100),
})

export type LightAccessoryConfig = z.infer<typeof lightAccessorySchema>

/**
 * Parent-host accessor that exposes the probed light capability surface
 * to this accessory. The base interface (`HikvisionAccessoryHost`)
 * carries the ISAPI client; this wider shape adds the per-light extras
 * the accessory needs without leaking camera internals.
 */
export interface HikvisionLightHost extends HikvisionAccessoryHost {
  /** Modes the camera advertised at probe time. Used to render the
   *  `mode` select. Empty array on cameras that don't expose any. */
  lightSupportedModes(): readonly string[]
}

const POLL_INTERVAL_MS = 30_000

export class HikvisionLightAccessory extends BaseDevice<typeof lightAccessorySchema> {
  readonly features = []

  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    ctx: DeviceContext,
    private readonly parent: HikvisionLightHost,
  ) {
    super(ctx, lightAccessorySchema, {
      type: DeviceType.Light,
      role: AccessoryKind.Floodlight,
    })
    this.registerSwitchCap()
    this.registerBrightnessCap()
    this.startPolling()
  }

  private get cameraNumber(): number {
    return this.config.get('cameraNumber') ?? 1
  }

  /** Mode applied when switching ON. Read fresh from config on every
   *  call so a settings save takes effect without a restart. */
  private get onMode(): string {
    return this.config.get('mode') ?? 'colorVuWhiteLight'
  }

  private switchView(): SwitchStatus {
    return this.getCapSlice(switchCapability) ?? { on: false, lastChangedAt: 0 }
  }
  private brightnessView(): BrightnessStatus {
    return (
      this.getCapSlice(brightnessCapability) ?? {
        level: this.config.get('defaultBrightness') ?? 100,
        lastChangedAt: 0,
      }
    )
  }

  /** Refresh on/off + brightness from firmware. The lib's
   *  `getSupplementLight` returns both in one call so we coalesce them
   *  here and write both slices atomically. */
  private async refreshFromFirmware(): Promise<void> {
    try {
      const isapi = this.parent.ensureClient()
      const state = await isapi.getSupplementLight(this.cameraNumber)
      if (!state) return
      const on = state.mode !== 'close'
      const ts = Date.now()
      const previousSwitch = this.switchView()
      const switchChangedAt = previousSwitch.on === on ? previousSwitch.lastChangedAt : ts
      this.setCapSlice(switchCapability, { on, lastChangedAt: switchChangedAt })
      if (typeof state.brightness === 'number') {
        const previousBrightness = this.brightnessView()
        const brightChangedAt =
          previousBrightness.level === state.brightness ? previousBrightness.lastChangedAt : ts
        this.setCapSlice(brightnessCapability, {
          level: state.brightness,
          lastChangedAt: brightChangedAt,
        })
      }
    } catch (err) {
      this.ctx.logger.debug('hikvision light refresh failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private async applyOn(on: boolean, brightness: number): Promise<void> {
    const isapi = this.parent.ensureClient()
    const mode = on ? this.onMode : 'close'
    // Push white-light brightness when arming (white-light cameras
    // honour `whiteLightBrightness` only while the corresponding mode
    // is active). Mode-only patch when turning off.
    await isapi.setSupplementLight(
      this.cameraNumber,
      on ? { mode, whiteLightBrightness: brightness } : { mode },
    )
    const ts = Date.now()
    this.setCapSlice(switchCapability, { on, lastChangedAt: ts })
    if (on) this.setCapSlice(brightnessCapability, { level: brightness, lastChangedAt: ts })
  }

  private startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.refreshFromFirmware()
    }, POLL_INTERVAL_MS)
  }

  override async removeDevice(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private registerSwitchCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      // Read straight from the runtime-state slice — the 30s background
      // poll + setState writes keep it fresh. CLAUDE.md anti-pattern:
      // don't refresh-on-every-getStatus; the slice IS the cache.
      getStatus: async (): Promise<SwitchStatus> => this.switchView(),
      setState: async ({ deviceId, on }) => {
        if (deviceId !== this.id) return
        const brightness = this.brightnessView().level
        await this.applyOn(on, brightness)
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    this.setCapSlice(switchCapability, { on: false, lastChangedAt: 0 })
  }

  private registerBrightnessCap(): void {
    const provider: InferNativeProvider<typeof brightnessCapability> = {
      // Slice-driven; same anti-pattern fix as switch.
      getStatus: async (): Promise<BrightnessStatus> => this.brightnessView(),
      setBrightness: async ({ deviceId, level: percentage }) => {
        if (deviceId !== this.id) return
        const value = Math.max(0, Math.min(100, percentage))
        // Lib accepts brightness only when the LED is on; otherwise
        // stash so the next setState({on:true}) re-issues with this
        // value baked in.
        if (this.switchView().on) {
          await this.applyOn(true, value)
        } else {
          this.setCapSlice(brightnessCapability, { level: value, lastChangedAt: Date.now() })
        }
      },
    }
    this.ctx.registerNativeCap(brightnessCapability, provider)
    this.setCapSlice(brightnessCapability, {
      level: this.config.get('defaultBrightness') ?? 100,
      lastChangedAt: 0,
    })
  }

  override getSettingsUISchema(): ConfigUISchemaWithValues {
    const supportedModes = this.parent.lightSupportedModes()
    const modeOptions = supportedModes
      .filter((m) => m !== 'close')
      .map((m) => ({ value: m, label: friendlyModeLabel(m) }))

    const schema: ConfigUISchema = {
      sections: [
        {
          id: 'light',
          title: 'Supplemental Light',
          titleKey: 'provider-hikvision:schema.s_light.title',
          columns: 2,
          fields: [
            modeOptions.length > 0
              ? {
                  type: 'select',
                  key: 'mode',
                  label: 'Mode (on)',
                  labelKey: 'provider-hikvision:schema.s_light.mode.label',
                  default: 'colorVuWhiteLight',
                  options: modeOptions,
                }
              : {
                  type: 'text',
                  key: 'mode',
                  label: 'Mode (on)',
                  labelKey: 'provider-hikvision:schema.s_light.mode.label',
                  description:
                    'Type the mode string the camera expects (e.g. `colorVuWhiteLight`).',
                  descriptionKey: 'provider-hikvision:schema.s_light.mode.description',
                  default: 'colorVuWhiteLight',
                },
            {
              type: 'number',
              key: 'defaultBrightness',
              label: 'Default brightness',
              labelKey: 'provider-hikvision:schema.s_light.defaultBrightness.label',
              default: 100,
              min: 0,
              max: 100,
              step: 1,
            },
          ],
        },
      ],
    }
    return hydrateSchema(schema, {
      mode: this.config.get('mode') ?? 'colorVuWhiteLight',
      defaultBrightness: this.config.get('defaultBrightness') ?? 100,
    })
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    const typed = lightAccessorySchema.partial().parse(patch)
    await this.config.setAll(typed)
    // If the operator changed `defaultBrightness` while OFF, refresh
    // the cached slice so the next read returns the new value.
    if (typed.defaultBrightness !== undefined && !this.switchView().on) {
      this.setCapSlice(brightnessCapability, {
        level: typed.defaultBrightness,
        lastChangedAt: Date.now(),
      })
    }
    // Mode change while ON: re-issue setSupplementLight with the new
    // mode + cached brightness so the camera switches the active
    // illumination mode immediately.
    if (typed.mode !== undefined && this.switchView().on) {
      await this.applyOn(true, this.brightnessView().level).catch((err: unknown) => {
        this.ctx.logger.warn('hikvision light: live mode switch failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }
  }
}

/**
 * Render Hikvision's terse mode strings into operator-friendly labels.
 * Unknown modes pass through verbatim — better to surface the raw
 * vendor token than to drop it from the select.
 */
function friendlyModeLabel(mode: string): string {
  switch (mode) {
    case 'colorVuWhiteLight':
      return 'ColorVu White Light'
    case 'manual':
      return 'Manual'
    case 'irLight':
      return 'IR Light'
    case 'mixed':
      return 'Mixed (IR + White)'
    case 'auto':
      return 'Auto'
    case 'schedule':
      return 'Scheduled'
    case 'eventTrigger':
      return 'Event Trigger'
    default:
      return mode
  }
}
