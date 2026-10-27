/**
 * FloodlightAccessory — child IDevice for the on-camera white-LED
 * floodlight.
 *
 * Caps:
 *   - `switch`         — discrete on/off via `setWhiteLedState(on,
 *                         brightness, channel)`
 *   - `brightness`     — dim level 0..100 — same lib call, the on/off
 *                         bit is preserved across brightness changes
 *   - `motion-trigger` — toggle "floodlight on motion" via
 *                         `setFloodlightOnMotion`
 *
 * State model: every cap's last-known state lives in the runtime-state
 * slice (per CLAUDE.md). Reads project from the slice, writes update
 * the slice optimistically, and a periodic poll re-syncs from firmware
 * so external changes (Reolink app, motion firing, firmware reverts)
 * surface in the UI without operator action.
 */

import { z } from 'zod'
import {
  BaseDevice,
  DeviceType,
  DeviceFeature,
  hydrateSchema,
  switchCapability,
  brightnessCapability,
  motionTriggerCapability,
  createRuntimeStateBridge,
  type SwitchStatus,
  type BrightnessStatus,
  type MotionTriggerStatus,
  type MotionTriggerRuntimeState,
  sleep,
} from '@camstack/types'
import type {
  ConfigUISchema,
  ConfigUISchemaWithValues,
  DeviceContext,
  InferNativeProvider,
  RawStateResult,
} from '@camstack/types'
import { reolinkAccessoryBaseSchema, type ReolinkAccessoryHost, AccessoryKind } from './base.js'
import { buildRawState } from '../raw-state.js'
import type { ReolinkBaichuanApi } from '@apocaliss92/nodelink-js'

/**
 * Detection-class strings the Reolink Baichuan firmware accepts for
 * `setFloodlightSettings({ detectType })`. These are the detection-class
 * combos the lib has been observed to accept across firmwares we support.
 * Operators can compose them via the multi-select UI; the driver passes
 * the joined string to the lib unchanged.
 */
const FLOODLIGHT_DETECT_TYPE_CHOICES = [
  'people',
  'vehicle',
  'dog_cat',
  'people,vehicle',
  'people,dog_cat',
  'vehicle,dog_cat',
  'people,vehicle,dog_cat',
] as const

export const floodlightAccessorySchema = reolinkAccessoryBaseSchema.extend({
  kind: z.literal(AccessoryKind.Floodlight),
  /**
   * Seconds the floodlight stays lit after a motion event. Forwarded
   * to `api.setFloodlightSettings(channel, { duration, detectType })`
   * (Baichuan FloodlightTask). Range 1..600s — values outside the
   * firmware-accepted range are silently clamped by the camera. */
  motionLightDurationS: z
    .number()
    .int()
    .min(1)
    .max(600)
    .default(180)
    .describe('Seconds the floodlight stays lit after motion (default 180)'),
  /**
   * Object classes that trigger the floodlight on motion. Combined as
   * a comma-separated string per Reolink's wire format. */
  motionLightDetectType: z
    .enum(FLOODLIGHT_DETECT_TYPE_CHOICES)
    .default('people,vehicle,dog_cat')
    .describe('Detection classes that turn the floodlight on'),
})

export type FloodlightAccessoryConfig = z.infer<typeof floodlightAccessorySchema>

/** Stale window for the runtime-state bridge — past this age, the next
 *  `getStatus()` call refreshes from firmware. Used by the
 *  motion-trigger bridge below; switch + brightness slices are written
 *  on every setState/setBrightness so they don't need a stale check. */
const STALE_MS = 30_000

/** Cooldown after a manual setState/setMotionTrigger — the parent's
 *  alignAuxDevicesState skips this accessory inside this window so a
 *  stale firmware read doesn't clobber the just-applied value
 *  (Reolink's GET endpoints lag the SET by 5-10s). */
const COOLDOWN_MS = 15_000

export class FloodlightAccessory extends BaseDevice<typeof floodlightAccessorySchema> {
  readonly features = [DeviceFeature.MotionTrigger]

  /** Wall-clock ms of the last operator-driven setState/setBrightness
   *  /setMotionTrigger. Read by the parent's align loop via the
   *  `ReolinkAccessoryRef.isInCooldown` impl below. */
  private lastSetAtMs = 0
  /** Becomes `true` once both `refreshLightFromFirmware` and
   *  `refreshMotionTriggerFromFirmware` have completed at least one
   *  successful round-trip. Used by `onProbe` to decide whether the
   *  boot-time sleep-gate should force a wake (no cached state) or
   *  skip (already-have-state path). Mirrors the Reolink mobile app's
   *  one-shot wake-and-fetch on launch. */
  private hasFetchedFromFirmware = false

  constructor(
    ctx: DeviceContext,
    private readonly parent: ReolinkAccessoryHost,
  ) {
    super(ctx, floodlightAccessorySchema, {
      type: DeviceType.Light,
      role: AccessoryKind.Floodlight,
    })
    this.registerSwitchCap()
    this.registerBrightnessCap()
    this.registerMotionTriggerCap()
    // No per-accessory polling — the parent ReolinkCamera runs a
    // single `alignAuxDevicesState` that drives all aux refreshes.
    // Battery cam: only on wake. Wired cam: every 10s.
    this.parent.registerAccessoryChild?.({
      kind: AccessoryKind.Floodlight,
      id: this.id,
      refreshFromAlign: async () => {
        await Promise.allSettled([
          this.refreshLightFromFirmware(),
          this.refreshMotionTriggerFromFirmware(),
        ])
      },
      isInCooldown: () => this.lastSetAtMs > 0 && Date.now() - this.lastSetAtMs < COOLDOWN_MS,
    })
  }

  private get channel(): number {
    return this.config.get('channel') ?? 0
  }
  private get api(): Promise<ReolinkBaichuanApi> {
    return this.parent.ensureApi() as Promise<ReolinkBaichuanApi>
  }

  /** RAW upstream state from the CACHED runtime-state slices (no camera
   *  round-trip), mirroring `ReolinkCamera.getRawState`. Surfaces the
   *  accessory's switch / brightness / motion-trigger slices in the
   *  State panel's Raw view. `null` until at least one slice is written. */
  async getRawState(): Promise<RawStateResult | null> {
    return buildRawState(this.runtimeState)
  }

  /** Refresh on/off + brightness from firmware and write both slices.
   *  The lib's `getWhiteLedState` returns both in one call so we
   *  coalesce them here. Failure path: log + leave the slices
   *  untouched. */
  private async refreshLightFromFirmware(): Promise<void> {
    try {
      const api = await this.api
      // Brightness comes from the WhiteLed state. On/off does NOT:
      // `WhiteLedState.enabled` is the white-LED / status-indicator LED, and
      // the lib doc warns doorbells return `<WhiteLed>` for their status LED
      // (NOT a floodlight) — so `enabled` reads stuck-true on a doorbell and
      // shows a phantom "floodlight on". The authoritative "currently lit"
      // signal is the cmd 291 FloodlightStatusList push
      // (`getCachedFloodlightStatus().value.status`), mirroring
      // the native Reolink plugin (which uses getWhiteLedState only for brightness).
      const state = await api.getWhiteLedState(this.channel)
      const brightness = typeof state?.brightness === 'number' ? state.brightness : undefined
      const cachedStatus = api.getCachedFloodlightStatus(this.channel)
      const ts = Date.now()
      this.ctx.logger.info('floodlight refresh OK — firmware state', {
        tags: { deviceId: this.id },
        meta: {
          floodlightStatus: cachedStatus?.value?.status,
          whiteLedEnabled: state?.enabled,
          brightness,
          channel: this.channel,
        },
      })
      // Only update on/off when the camera has actually reported a floodlight
      // status (cmd 291). Absent (e.g. a doorbell whose WhiteLed is just a
      // status LED) → leave the switch slice at its cold-start seed so we never
      // surface a phantom "on".
      if (cachedStatus !== undefined) {
        this.setCapSlice(switchCapability, {
          on: Boolean(cachedStatus.value?.status),
          lastChangedAt: ts,
        })
      }
      if (brightness !== undefined) {
        this.setCapSlice(brightnessCapability, { level: brightness, lastChangedAt: ts })
      }
      this.hasFetchedFromFirmware = true
    } catch (err) {
      this.ctx.logger.warn('floodlight refresh FAILED — slice stays at cold-start seed', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err), channel: this.channel },
      })
    }
  }

  /**
   * Kernel-driven probe (Phase 4). Runs on every device construction
   * + addon restart. Pulls the actual on/off + brightness +
   * motion-trigger state from the camera so the slices reflect
   * firmware truth instead of the conservative cold-start seeds
   * written in `registerSwitchCap` / `registerBrightnessCap` /
   * `registerMotionTriggerCap`.
   *
   * Sleeping battery cam:
   *   1. **First-time probe (no cached state yet)** — force a one-shot
   *      wake + fetch so the operator sees a populated UI at launch.
   *      Mirrors the Reolink mobile app: at app launch it wakes the
   *      cam once to fetch initial state. Without this, an aggressive
   *      sleep timeout (~14s) can return the cam to sleep before the
   *      kernel finishes its initial probe pass — the retry chain
   *      exhausts and the slices never populate.
   *   2. **Subsequent probes (slices already populated)** — skip. A
   *      poll on a sleeping camera returns 400 and drains the
   *      battery. The parent's `alignAuxDevicesState('wake')` runs
   *      on the next wake transition (simpleEvent push or sleep-poll
   *      backstop) and refreshes both slices then.
   */
  override async onProbe(): Promise<void> {
    const isSleepingBattery =
      this.parent.isBatteryCam?.() === true && this.parent.isSleeping?.() === true
    if (isSleepingBattery) {
      if (this.hasFetchedFromFirmware) {
        this.ctx.logger.debug(
          'floodlight onProbe skipped — parent battery cam is sleeping (have cached state)',
          {
            tags: { deviceId: this.id },
          },
        )
        return
      }
      // First-time probe: wake the cam to fetch initial state.
      // Best-effort — if wake fails we still proceed with the fetch.
      // Mirrors `wakeForIntercom` in the parent camera class
      // (waitAfterWakeMs:2000 + 1s settle).
      this.ctx.logger.info('floodlight onProbe forcing wake — initial probe with no cached state', {
        tags: { deviceId: this.id },
      })
      try {
        const api = await this.api
        await api.wakeUp(this.channel, { waitAfterWakeMs: 2000 })
        await sleep(1000)
      } catch (err) {
        this.ctx.logger.warn('floodlight wake before initial probe failed — proceeding anyway', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    await Promise.all([this.refreshLightFromFirmware(), this.refreshMotionTriggerFromFirmware()])
  }

  /** Refresh motion-trigger from firmware and write the slice. Also
   *  mirrors the camera-current `duration` + `detectType` into config
   *  so the Settings form shows firmware truth instead of stale
   *  operator-typed values, and the next motion-trigger arm doesn't
   *  clobber the operator's app-side change.
   *
   *  Mirror is best-effort: a `detectType` value not in
   *  `FLOODLIGHT_DETECT_TYPE_CHOICES` (e.g. firmware advertised a
   *  combination we don't list) is logged + skipped — leaves the
   *  config field untouched rather than throwing the whole refresh. */
  private async refreshMotionTriggerFromFirmware(): Promise<void> {
    try {
      const api = await this.api
      const result = await api.getFloodlightOnMotion(this.channel)
      const enabled = Boolean(result?.floodlightOnMotion)
      const previous = this.getCapSlice(motionTriggerCapability)
      const lastChangedAt =
        previous && previous.enabled === enabled ? previous.lastChangedAt : Date.now()
      this.setCapSlice(motionTriggerCapability, {
        enabled,
        lastChangedAt,
        lastFetchedAt: Date.now(),
      })
      this.hasFetchedFromFirmware = true

      // Mirror tuning fields → config. `duration` ranges 1..600s on
      // the schema; firmware-reported value sits well inside. The
      // schema is `z.enum(...)`, so an unrecognised `detectType`
      // (firmware advertising a combo we don't enumerate) would
      // throw — guard with the known-choice check.
      const patch: Record<string, unknown> = {}
      if (typeof result?.duration === 'number' && result.duration > 0) {
        patch['motionLightDurationS'] = result.duration
      }
      if (typeof result?.detectType === 'string') {
        const normalized = (FLOODLIGHT_DETECT_TYPE_CHOICES as readonly string[]).includes(
          result.detectType,
        )
          ? result.detectType
          : undefined
        if (normalized !== undefined) {
          patch['motionLightDetectType'] = normalized
        } else {
          this.ctx.logger.debug('floodlight detectType outside enum — skipping config mirror', {
            tags: { deviceId: this.id, channel: this.channel },
            meta: { detectType: result.detectType },
          })
        }
      }
      if (Object.keys(patch).length > 0) {
        await this.config.setAll(patch).catch((err: unknown) => {
          this.ctx.logger.debug('floodlight config mirror failed', {
            tags: { deviceId: this.id, channel: this.channel },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        })
      }
    } catch (err) {
      this.ctx.logger.warn('floodlight motion-trigger fetch failed', {
        tags: { deviceId: this.id, channel: this.channel },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  // ── Cached projections ──────────────────────────────────────────────

  /** Last-known on/off + change timestamp. Defaults match the cold-
   *  start seed values written below. */
  private switchView(): SwitchStatus {
    return this.getCapSlice(switchCapability) ?? { on: false, lastChangedAt: 0 }
  }
  private brightnessView(): BrightnessStatus {
    return this.getCapSlice(brightnessCapability) ?? { level: 100, lastChangedAt: 0 }
  }

  private registerSwitchCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      // Slice-driven read — the parent's align loop refreshes
      // periodically; per-call firmware reads would defeat the
      // align-cooldown contract.
      getStatus: async (): Promise<SwitchStatus> => this.switchView(),
      setState: async ({ deviceId, on }) => {
        if (deviceId !== this.id) return
        const api = await this.api
        // CRITICAL: pass ONLY state, NEVER include brightness in a toggle.
        // Reolink firmware treats `SetWhiteLed { state, bright }` as a
        // full FloodlightTask write — i.e. it also re-engages
        // `alarmMode=1` (floodlight-on-motion). Passing only `state`
        // keeps the cmd to the manual-toggle path: on/off never
        // co-bundles brightness. To change brightness, call
        // `setBrightness` which sends a state-less SetWhiteLed.
        await api.setWhiteLedState(this.channel, on)
        this.setCapSlice(switchCapability, { on, lastChangedAt: Date.now() })
        this.lastSetAtMs = Date.now()
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    // Cold-start seed — keeps the SwitchHero out of "Awaiting state…"
    // until the first refresh writes the firmware-reported value.
    this.setCapSlice(switchCapability, { on: false, lastChangedAt: 0 })
  }

  private registerBrightnessCap(): void {
    const provider: InferNativeProvider<typeof brightnessCapability> = {
      getStatus: async (): Promise<BrightnessStatus> => this.brightnessView(),
      setBrightness: async ({ deviceId, level: percentage }) => {
        if (deviceId !== this.id) return
        const value = Math.max(0, Math.min(100, percentage))
        // Lib accepts brightness only when the LED is on; otherwise we
        // just stash the slice value so the next setState({on:true})
        // re-issues setWhiteLedState with this brightness.
        if (this.switchView().on) {
          const api = await this.api
          // Send a state-less SetWhiteLed with ONLY the brightness field. Bundling state would also
          // re-engage `alarmMode=1` on the FloodlightTask path, which
          // would flip motion-trigger to ON as a side effect of changing
          // brightness — exactly the bug the setState comment guards.
          await api.setWhiteLedState(this.channel, undefined, value)
        }
        this.setCapSlice(brightnessCapability, { level: value, lastChangedAt: Date.now() })
        this.lastSetAtMs = Date.now()
      },
    }
    this.ctx.registerNativeCap(brightnessCapability, provider)
    this.setCapSlice(brightnessCapability, { level: 100, lastChangedAt: 0 })
  }

  private registerMotionTriggerCap(): void {
    const bridge = createRuntimeStateBridge({
      runtimeState: this.runtimeState,
      cap: motionTriggerCapability,
      ownDeviceId: this.id,
      refresh: () => this.refreshMotionTriggerFromFirmware(),
      staleMs: STALE_MS,
      empty: (): MotionTriggerStatus => ({ enabled: false, lastChangedAt: 0 }),
    })

    const provider: InferNativeProvider<typeof motionTriggerCapability> = {
      getStatus: bridge.getStatus,
      setMotionTrigger: async ({ deviceId, enabled }) => {
        if (deviceId !== this.id) return
        this.ctx.logger.info('floodlight motion-trigger setMotionTrigger', {
          tags: { deviceId: this.id, channel: this.channel },
          meta: { enabled },
        })
        try {
          const api = await this.api
          await api.setFloodlightOnMotion(enabled, this.channel)
          // Always re-push duration + detectType when arming the
          // motion-trigger — always re-push duration + detectType so
          // the camera's auto-light timing matches the operator's saved
          // preference, not whatever the firmware defaults to.
          if (enabled) await this.pushFloodlightSettings()
          // Optimistic write — periodic poll will reconcile if firmware
          // doesn't actually persist (e.g. preconditions missing).
          this.setCapSlice(motionTriggerCapability, {
            enabled,
            lastChangedAt: Date.now(),
            lastFetchedAt: Date.now(),
          })
          this.lastSetAtMs = Date.now()
        } catch (err) {
          this.ctx.logger.warn('floodlight motion-trigger set failed', {
            tags: { deviceId: this.id, channel: this.channel },
            meta: { enabled, error: err instanceof Error ? err.message : String(err) },
          })
          throw err
        }
      },
    }
    this.ctx.registerNativeCap(motionTriggerCapability, provider)
    // Cold-start seed: the slice exists but with stale=true so the
    // first getStatus / poll round-trip is the source of truth.
    const seed: MotionTriggerRuntimeState = { enabled: false, lastChangedAt: 0, lastFetchedAt: 0 }
    this.setCapSlice(motionTriggerCapability, seed)
  }

  /**
   * Push the saved `duration` + `detectType` to the firmware via the
   * Baichuan FloodlightTask command. Used both on settings save (via
   * `applySettingsPatch` triggering a reapply) and right after arming
   * motion-trigger so the camera honours the operator-set timing
   * instead of the firmware default.
   */
  private async pushFloodlightSettings(): Promise<void> {
    const duration = this.config.get('motionLightDurationS') ?? 180
    const detectType = this.config.get('motionLightDetectType') ?? 'people,vehicle,dog_cat'
    try {
      const api = await this.api
      await api.setFloodlightSettings(this.channel, { duration, detectType })
    } catch (err) {
      this.ctx.logger.warn('floodlight motion settings push failed', {
        tags: { deviceId: this.id, channel: this.channel },
        meta: { duration, detectType, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  override getSettingsUISchema(): ConfigUISchemaWithValues {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 'motion-floodlight',
          title: 'Motion-triggered floodlight',
          titleKey: 'provider-reolink:schema.s_motion-floodlight.title',
          columns: 2,
          fields: [
            {
              type: 'number',
              key: 'motionLightDurationS',
              label: 'Light duration (s)',
              labelKey: 'provider-reolink:schema.s_motion-floodlight.motionLightDurationS.label',
              min: 1,
              max: 600,
              step: 1,
              default: 180,
            },
            {
              type: 'select',
              key: 'motionLightDetectType',
              label: 'Detection classes',
              labelKey: 'provider-reolink:schema.s_motion-floodlight.motionLightDetectType.label',
              options: FLOODLIGHT_DETECT_TYPE_CHOICES.map((v) => ({
                value: v,
                label: v.replace(/,/g, ' + ').replace(/_/g, '+'),
              })),
              default: 'people,vehicle,dog_cat',
            },
          ],
        },
      ],
    }
    return hydrateSchema(schema, {
      motionLightDurationS: this.config.get('motionLightDurationS'),
      motionLightDetectType: this.config.get('motionLightDetectType'),
    })
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    await this.config.setAll(patch)
    if ('motionLightDurationS' in patch || 'motionLightDetectType' in patch) {
      await this.pushFloodlightSettings()
    }
  }
}
