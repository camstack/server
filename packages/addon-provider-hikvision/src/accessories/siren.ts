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
 *   - `motion-trigger` — the camera's VMD event linkage `beep` (audio alarm),
 *                 `/ISAPI/Event/triggers/VMD-{cam}` notificationMethod `beep`
 *   - `siren` — timed trigger: holds the alarm input for N seconds, publishes
 *                 `activeUntil`; options are camera-probed (see siren-options.ts)
 *
 * Settings:
 *   - `port`            — alarm input port id (`/ISAPI/System/IO/inputs/{N}`).
 *                          Default 1 (the most common GPIO slot for the
 *                          built-in siren). Multi-input cameras can pick
 *                          a different port via the settings UI.
 *   - `pulseDurationMs` — auto-release the input after N ms (0 =
 *                          manual release).
 *
 * Notes on the persisted-state model: the alarm input's ISAPI document is
 * *configuration*, not activity, and nothing here reads the siren's real
 * activity. The runtime-state slice is the only source and is written by
 * CamStack's own triggers; a siren toggled outside CamStack is not tracked
 * until the next trigger or stop.
 */

import type {
  ConfigUISchema,
  ConfigUISchemaWithValues,
  DeviceContext,
  InferNativeProvider,
} from '@camstack/types'
import {
  BaseDevice,
  createRuntimeStateBridge,
  DeviceFeature,
  DeviceType,
  hydrateSchema,
  type MotionTriggerRuntimeState,
  type MotionTriggerStatus,
  motionTriggerCapability,
  resolveSirenSeconds,
  type SirenOptions,
  type SirenStatus,
  sirenCapability,
  sirenIdleStatus,
  sirenTriggeredStatus,
  type SwitchStatus,
  switchCapability,
} from '@camstack/types'
import { z } from 'zod'
import { AccessoryKind, type HikvisionAccessoryHost, hikvisionAccessoryBaseSchema } from './base.js'
import { buildHikvisionSirenOptions } from './siren-options.js'

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

const MOTION_TRIGGER_STALE_MS = 30_000

export class HikvisionSirenAccessory extends BaseDevice<typeof sirenAccessorySchema> {
  readonly features = [DeviceFeature.MotionTrigger]

  /** Pending auto-release timer fired after `pulseDurationMs`. */
  private pulseTimer: ReturnType<typeof setTimeout> | null = null

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
    this.registerMotionTriggerCap()
    this.registerSirenCap()
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

  private sirenView(): SirenStatus {
    return this.getCapSlice(sirenCapability) ?? sirenIdleStatus(undefined)
  }

  private openEndedStatus(): SirenStatus {
    return { active: true, activeUntil: null, durationSeconds: null, lastTriggeredAt: Date.now() }
  }

  private publishSiren(status: SirenStatus): void {
    const previous = this.runtimeState.getCapState<{ lastFetchedAt?: number }>('siren')
    this.setCapSlice(sirenCapability, { ...status, lastFetchedAt: previous?.lastFetchedAt ?? 0 })
  }

  /** Releases the input after `seconds` and publishes the countdown it implies. */
  private armRelease(seconds: number): void {
    this.cancelPulseTimer()
    this.publishSiren(sirenTriggeredStatus(Date.now(), seconds))
    this.pulseTimer = setTimeout(
      () => {
        this.pulseTimer = null
        this.pushAlarmInput(false)
          .then(() => this.publishSiren(sirenIdleStatus(this.sirenView())))
          .catch((err: unknown) => {
            this.ctx.logger.warn('hikvision siren: pulse auto-release failed', {
              tags: { deviceId: this.id },
              meta: { port: this.port, error: err instanceof Error ? err.message : String(err) },
            })
          })
      },
      Math.round(seconds * 1000),
    )
    // unref: a pending release must not keep the process alive at shutdown. The
    // release itself is not lost: removeDevice drops the input on a clean stop,
    // and the camera's own linkage ends on a crash.
    this.pulseTimer.unref()
  }

  /** Asks the camera whether the configured alarm input exists; failure means "not confirmed". */
  private async sirenOptions(): Promise<SirenOptions> {
    let confirmed = false
    try {
      const inputs = await this.parent.ensureClient().getAlarmInputs()
      confirmed = (inputs ?? []).some((input) => input.id === String(this.port))
    } catch (err) {
      this.ctx.logger.debug('hikvision siren: alarm input probe failed', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
    const options = buildHikvisionSirenOptions({
      pulseDurationMs: this.config.get('pulseDurationMs') ?? 0,
      portConfirmedByCamera: confirmed,
      nowMs: Date.now(),
    })
    if (confirmed) {
      const previous = this.runtimeState.getCapState<SirenStatus>('siren')
      this.setCapSlice(sirenCapability, {
        ...(previous ?? sirenIdleStatus(undefined)),
        lastFetchedAt: options.fetchedAt,
      })
    }
    return options
  }

  private registerSirenCap(): void {
    const provider: InferNativeProvider<typeof sirenCapability> = {
      getStatus: async (): Promise<SirenStatus> => this.sirenView(),
      getOptions: async (): Promise<SirenOptions> => this.sirenOptions(),
      trigger: async ({ deviceId, durationSeconds }): Promise<SirenStatus> => {
        if (deviceId !== this.id) return this.sirenView()
        const seconds = resolveSirenSeconds(await this.sirenOptions(), durationSeconds)
        this.cancelPulseTimer()
        await this.pushAlarmInput(true)
        this.armRelease(seconds)
        this.ctx.logger.info('hikvision siren: timed trigger', {
          tags: { deviceId: this.id },
          meta: { requested: durationSeconds ?? 'default', seconds, port: this.port },
        })
        return this.sirenView()
      },
      stop: async ({ deviceId }): Promise<SirenStatus> => {
        if (deviceId !== this.id) return this.sirenView()
        this.cancelPulseTimer()
        await this.pushAlarmInput(false)
        this.publishSiren(sirenIdleStatus(this.sirenView()))
        return this.sirenView()
      },
    }
    this.ctx.registerNativeCap(sirenCapability, provider)
    this.publishSiren(sirenIdleStatus(undefined))
  }

  private get cameraNumber(): number {
    return this.config.get('cameraNumber') ?? 1
  }

  /** Reads the VMD linkage; the audio alarm is the `beep` notification method. Failure leaves the slice as it was. */
  private async refreshMotionTriggerFromFirmware(): Promise<void> {
    const linkage = await this.parent.ensureClient().getMotionTriggerLinkage(this.cameraNumber)
    if (linkage === null) {
      this.ctx.logger.warn('hikvision siren: motion linkage read failed', {
        tags: { deviceId: this.id },
      })
      return
    }
    const enabled = linkage.beep
    const previous = this.getCapSlice(motionTriggerCapability)
    this.setCapSlice(motionTriggerCapability, {
      enabled,
      lastChangedAt: previous && previous.enabled === enabled ? previous.lastChangedAt : Date.now(),
      lastFetchedAt: Date.now(),
    })
  }

  private registerMotionTriggerCap(): void {
    const bridge = createRuntimeStateBridge({
      runtimeState: this.runtimeState,
      cap: motionTriggerCapability,
      ownDeviceId: this.id,
      refresh: () => this.refreshMotionTriggerFromFirmware(),
      staleMs: MOTION_TRIGGER_STALE_MS,
      empty: (): MotionTriggerStatus => ({ enabled: false, lastChangedAt: 0 }),
    })
    const provider: InferNativeProvider<typeof motionTriggerCapability> = {
      getStatus: bridge.getStatus,
      setMotionTrigger: async ({ deviceId, enabled }) => {
        if (deviceId !== this.id) return
        this.ctx.logger.info('hikvision siren: setMotionTrigger (VMD beep linkage)', {
          tags: { deviceId: this.id },
          meta: { enabled, cameraNumber: this.cameraNumber },
        })
        await this.parent
          .ensureClient()
          .setMotionTriggerLinkage(this.cameraNumber, { beep: enabled })
        this.setCapSlice(motionTriggerCapability, {
          enabled,
          lastChangedAt: Date.now(),
          lastFetchedAt: Date.now(),
        })
      },
    }
    this.ctx.registerNativeCap(motionTriggerCapability, provider)
    const seed: MotionTriggerRuntimeState = { enabled: false, lastChangedAt: 0, lastFetchedAt: 0 }
    this.setCapSlice(motionTriggerCapability, seed)
  }

  private registerSwitchCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      // Read straight from the runtime-state slice that setState writes;
      // the slice IS the cache (no refresh on every getStatus).
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
          this.armRelease(pulseMs / 1000)
        } else {
          this.publishSiren(on ? this.openEndedStatus() : sirenIdleStatus(this.sirenView()))
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
      this.publishSiren(sirenIdleStatus(this.sirenView()))
    }
  }

  override async removeDevice(): Promise<void> {
    this.cancelPulseTimer()
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
