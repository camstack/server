/**
 * HikvisionSirenAccessory — child IDevice for the on-camera siren
 * driven via the alarm-input mechanism (`/ISAPI/System/IO/inputs/{port}`).
 *
 * Caps:
 *   - `switch` — discrete on/off via `setAlarmInput(on, port)`. The
 *                 actual audible/visual response is configured on the
 *                 camera-side "Linkage Method" — this cap only flips
 *                 the input state and the camera fires the linkage.
 *
 * Settings:
 *   - `port`            — alarm input port id (`/ISAPI/System/IO/inputs/{N}`).
 *                          Default 1 (the most common GPIO slot for the
 *                          built-in siren). Multi-input cameras can pick
 *                          a different port via the settings UI.
 *   - `pulseDurationMs` — auto-release the input after N ms (0 =
 *                          manual release).
 *
 * Notes on the persisted-state model: Hikvision's `getAlarmInput` GET
 * reflects the *configured* state, not the *active* trigger. The
 * runtime-state slice is the authoritative source for operator-driven
 * flips; a 30s background poll re-reads firmware so external changes
 * (camera-side linkage, panel toggle) surface in the UI.
 */

import type {
  ConfigUISchema,
  ConfigUISchemaWithValues,
  DeviceContext,
  InferNativeProvider,
} from '@camstack/types'
import {
  BaseDevice,
  DeviceType,
  hydrateSchema,
  type SwitchStatus,
  switchCapability,
} from '@camstack/types'
import { z } from 'zod'
import { AccessoryKind, type HikvisionAccessoryHost, hikvisionAccessoryBaseSchema } from './base.js'

export const sirenAccessorySchema = hikvisionAccessoryBaseSchema.extend({
  kind: z.literal(AccessoryKind.Siren),
  /**
   * GPIO port id (`/ISAPI/System/IO/inputs/{port}`). Default 1.
   * Multi-input cameras can pick a different port via the settings UI;
   * the select is populated from the parent's probe.
   */
  port: z.number().int().positive().default(1),
  /**
   * Optional auto-release window. When >0, an `on:true` flip schedules
   * an `on:false` flip after this many milliseconds, mimicking a
   * one-shot pulse. When 0, the operator must flip back manually.
   */
  /** Default 5s pulse — a sticky ON left the siren sounding until a manual off. */
  pulseDurationMs: z.number().int().min(0).max(600_000).default(5_000),
})

export type SirenAccessoryConfig = z.infer<typeof sirenAccessorySchema>

/**
 * Parent-host accessor that exposes the probed alarm-input surface to
 * this accessory. The base interface (`HikvisionAccessoryHost`) carries
 * the ISAPI client; this wider shape adds the per-siren extras the
 * accessory needs without leaking camera internals.
 */
export interface HikvisionSirenHost extends HikvisionAccessoryHost {
  /** Alarm input port ids the camera advertised at probe time. Used
   *  to render the `port` select. Empty array on single-port devices
   *  (the schema default of `1` is then the only valid choice). */
  alarmInputPorts(): readonly number[]
}

const POLL_INTERVAL_MS = 30_000

export class HikvisionSirenAccessory extends BaseDevice<typeof sirenAccessorySchema> {
  readonly features = []

  /** Pending auto-release timer fired after `pulseDurationMs`. */
  private pulseTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    ctx: DeviceContext,
    private readonly parent: HikvisionSirenHost,
  ) {
    super(ctx, sirenAccessorySchema, {
      type: DeviceType.Siren,
      role: AccessoryKind.Siren,
    })
    // Seed used to be 0 (manual release). That left sirens ON after a
    // setState(true) with no off step — migrate the silent seed to 5s.
    if ((this.config.get('pulseDurationMs') ?? 0) === 0) {
      void this.config.set('pulseDurationMs', 5_000)
    }
    this.registerSwitchCap()
    this.startPolling()
  }

  private get port(): number {
    return this.config.get('port') ?? 1
  }

  private cancelPulseTimer(): void {
    if (!this.pulseTimer) return
    clearTimeout(this.pulseTimer)
    this.pulseTimer = null
  }

  private switchView(): SwitchStatus {
    return this.getCapSlice(switchCapability) ?? { on: false, lastChangedAt: 0 }
  }

  /** Refresh the alarm-input state from firmware. ISAPI's
   *  `getAlarmInput` reflects configured state, not the active trigger,
   *  so a poll is meaningful only to surface changes made by other
   *  clients (panel toggle, ISAPI script). */
  private async refreshFromFirmware(): Promise<void> {
    const isapi = this.parent.ensureClient()
    const reader = (
      isapi as { getAlarmInput?: (port: number) => Promise<{ active?: boolean } | null> }
    ).getAlarmInput
    if (!reader) return
    try {
      const state = await reader.call(isapi, this.port)
      const on = Boolean(state?.active)
      const previous = this.switchView()
      const lastChangedAt = previous.on === on ? previous.lastChangedAt : Date.now()
      this.setCapSlice(switchCapability, { on, lastChangedAt })
    } catch (err) {
      this.ctx.logger.debug('hikvision siren refresh failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private async pushAlarmInput(on: boolean): Promise<void> {
    const isapi = this.parent.ensureClient()
    this.ctx.logger.info('hikvision siren: PUT /ISAPI/System/IO/inputs — alarm input write', {
      meta: { deviceId: this.id, on, port: this.port },
    })
    try {
      await isapi.setAlarmInput(on, this.port)
      this.ctx.logger.info('hikvision siren: alarm input write OK', {
        meta: { deviceId: this.id, on, port: this.port },
      })
    } catch (err) {
      this.ctx.logger.warn('hikvision siren: alarm input write FAILED', {
        meta: {
          deviceId: this.id,
          on,
          port: this.port,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      throw err
    }
    this.setCapSlice(switchCapability, { on, lastChangedAt: Date.now() })
  }

  private startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.refreshFromFirmware()
    }, POLL_INTERVAL_MS)
  }

  private registerSwitchCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      // Read straight from the runtime-state slice — the 30s
      // background poll + setState writes keep it fresh. CLAUDE.md
      // anti-pattern: don't refresh-on-every-getStatus; the slice IS
      // the cache.
      getStatus: async (): Promise<SwitchStatus> => this.switchView(),
      setState: async ({ deviceId, on }) => {
        if (deviceId !== this.id) {
          this.ctx.logger.debug('hikvision siren: switch setState ignored — deviceId mismatch', {
            meta: { incoming: deviceId, own: this.id },
          })
          return
        }
        this.ctx.logger.info('hikvision siren: switch setState invoked', {
          meta: { deviceId, on, port: this.port },
        })
        // Cancel any in-flight pulse — a fresh flip supersedes the
        // pending auto-release. Symmetric on both `on:true` (operator
        // re-arms the pulse) and `on:false` (operator manually releases
        // before the timer fires).
        this.cancelPulseTimer()
        await this.pushAlarmInput(on)

        const pulseMs = this.config.get('pulseDurationMs') ?? 0
        if (on && pulseMs > 0) {
          this.pulseTimer = setTimeout(() => {
            this.pulseTimer = null
            this.pushAlarmInput(false).catch((err: unknown) => {
              this.ctx.logger.warn('hikvision siren: pulse auto-release failed', {
                meta: {
                  port: this.port,
                  error: err instanceof Error ? err.message : String(err),
                },
              })
            })
          }, pulseMs)
        }
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    this.setCapSlice(switchCapability, { on: false, lastChangedAt: 0 })
  }

  override getSettingsUISchema(): ConfigUISchemaWithValues {
    const probed = this.parent.alarmInputPorts()
    const current = this.config.get('port') ?? 1
    const probedSummary =
      probed.length > 0
        ? `Detected ports: ${probed.join(', ')}.`
        : 'No probe data (single-input camera).'

    const schema: ConfigUISchema = {
      sections: [
        {
          id: 'siren',
          title: 'Siren / Alarm Output',
          titleKey: 'provider-hikvision:schema.s_siren.title',
          description:
            'The siren tone is set in the camera-side Linkage Method; this only fires the input.',
          descriptionKey: 'provider-hikvision:schema.s_siren.description',
          columns: 2,
          fields: [
            {
              type: 'number',
              key: 'port',
              label: 'Alarm input port',
              labelKey: 'provider-hikvision:schema.s_siren.port.label',
              description: `Change only if the siren is wired to an input other than 1. ${probedSummary}`,
              default: 1,
              min: 1,
              max: 32,
              step: 1,
            },
            {
              type: 'number',
              key: 'pulseDurationMs',
              label: 'Auto-release after (ms)',
              labelKey: 'provider-hikvision:schema.s_siren.pulseDurationMs.label',
              description: 'Auto-off delay in ms; 0 = manual release.',
              descriptionKey: 'provider-hikvision:schema.s_siren.pulseDurationMs.description',
              default: 5_000,
              min: 0,
              max: 600_000,
              step: 100,
            },
          ],
        },
      ],
    }
    return hydrateSchema(schema, {
      port: current,
      pulseDurationMs: this.config.get('pulseDurationMs') ?? 0,
    })
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    const typed = sirenAccessorySchema.partial().parse(patch)
    const previousPort = this.port
    await this.config.setAll(typed)
    // Port change while currently ON: release the OLD port immediately
    // — leaving it triggered after the operator switched the accessory
    // to a different GPIO is unsafe.
    if (typed.port !== undefined && this.switchView().on && typed.port !== previousPort) {
      try {
        const isapi = this.parent.ensureClient()
        await isapi.setAlarmInput(false, previousPort)
      } catch (err) {
        this.ctx.logger.warn('hikvision siren: post-port-change release failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
      this.setCapSlice(switchCapability, { on: false, lastChangedAt: Date.now() })
      this.cancelPulseTimer()
    }
  }

  override async removeDevice(): Promise<void> {
    this.cancelPulseTimer()
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.switchView().on) {
      try {
        await this.pushAlarmInput(false)
      } catch (err) {
        this.ctx.logger.debug('hikvision siren: best-effort release on removeDevice failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
  }
}
