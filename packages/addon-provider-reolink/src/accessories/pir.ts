/**
 * PirAccessory — child IDevice for the on-camera passive-infrared
 * motion sensor (Argus / Duo battery models).
 *
 * Caps:
 *   - `switch` — discrete enable/disable via cmd_id 153 (SetPirInfo)
 *
 * Settings:
 *   - `pirSensitive`     — 1..100 (firmware tolerance to small motion)
 *   - `pirIntervalS`     — minimum delay between consecutive triggers
 *   - `pirReduceAlarm`   — boolean false-positive reduction toggle
 *
 * Switch state lives in the runtime-state slice; a 30s background poll
 * keeps it aligned with whatever the camera reports so external flips
 * (mobile app, motion auto-reset) surface in the UI without operator
 * action. Settings save pushes the FULL `SetPirInfo` payload — the lib
 * doesn't expose per-field mutators.
 */

import { z } from 'zod'
import {
  BaseDevice,
  DeviceType,
  hydrateSchema,
  switchCapability,
  type SwitchStatus,
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

export const pirAccessorySchema = reolinkAccessoryBaseSchema.extend({
  kind: z.literal(AccessoryKind.PirSensor),
  // No zod defaults — these mirror firmware-current values and would
  // mislead the UI (showing "50" when the camera actually has "70").
  // The accessory's `refreshSwitchFromExternal` mirrors `getPirInfo`
  // → config on every align refresh, so the UI form pulls camera
  // truth directly. Optional gates the cold-start window before the
  // first refresh lands; `pushConfigToFirmware` skips undefined
  // fields so the lib's setPirInfo read-modify-write preserves
  // unspecified camera values.
  pirSensitive: z.number().int().min(1).max(100).optional(),
  pirReduceAlarm: z.boolean().optional(),
  // Range matches what the Reolink mobile app exposes for the PIR
  // detection cooldown: 5..120s. Firmware rejects values outside the
  // window with HTTP 400. The per-cam `intervalMax` mirrored from
  // `getPirInfo` (see `pirIntervalMax` below) is informational —
  // every model we support returns 120 — but we don't use it as the
  // schema cap because the firmware-reported value can in principle
  // be lower than 120 on some models, and clamping the schema below
  // 120 would silently reject a fully valid app-side value.
  pirIntervalS: z.number().int().min(5).max(120).optional(),
  /** Firmware-advertised upper bound for `pirIntervalS` — read from
   *  `getPirInfo`'s `state.intervalMax` and mirrored on every align
   *  refresh. Drives the operator slider's max in
   *  `getSettingsUISchema`; absent value falls back to `60`
   *  firmware-default fallback when `getPirInfo` doesn't return `intervalMax`. */
  pirIntervalMax: z.number().int().positive().optional(),
})

export type PirAccessoryConfig = z.infer<typeof pirAccessorySchema>

/** Cooldown after operator-driven setState — parent's
 *  alignAuxDevicesState skips this accessory inside the window. */
const COOLDOWN_MS = 15_000

export class PirAccessory extends BaseDevice<typeof pirAccessorySchema> {
  readonly features = []

  private lastSetAtMs = 0
  /** Becomes `true` after the first successful `refreshFromFirmware`
   *  round-trip. Used by `onProbe` to decide whether the boot-time
   *  sleep-gate should force a wake (no cached state) or skip
   *  (already-have-state path). Mirrors the Reolink mobile app's
   *  one-shot wake-and-fetch on launch. */
  private hasFetchedFromFirmware = false

  constructor(
    ctx: DeviceContext,
    private readonly parent: ReolinkAccessoryHost,
  ) {
    super(ctx, pirAccessorySchema, {
      type: DeviceType.Switch,
      role: AccessoryKind.PirSensor,
    })
    this.registerSwitchCap()
    // No per-accessory polling — parent's alignAuxDevicesState drives
    // refresh on a single 10s timer (wired) or wake transition (battery).
    this.parent.registerAccessoryChild?.({
      kind: AccessoryKind.PirSensor,
      id: this.id,
      refreshFromAlign: () => this.refreshFromFirmware(),
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
   *  accessory's switch slice in the State panel's Raw view. `null`
   *  until at least one slice is written. */
  async getRawState(): Promise<RawStateResult | null> {
    return buildRawState(this.runtimeState)
  }

  private switchView(): SwitchStatus {
    return this.getCapSlice(switchCapability) ?? { on: false, lastChangedAt: 0 }
  }

  /** Refresh switch + tuning slices from a firmware payload. The lib
   *  surfaces the camera-current PIR config in `state.{sensitive,
   *  reduceAlarm, interval}`; we mirror them into the accessory's
   *  config so the UI reflects camera truth instead of stale
   *  schema defaults (50 / false / 5). Called by the parent's
   *  `alignAuxDevicesState()` — the parent owns the scheduling
   *  (poll cadence + sleep gate + cooldown), the accessory just owns
   *  the slice projection. */
  refreshSwitchFromExternal(state: {
    enabled?: boolean
    state?: { sensitive?: number; reduceAlarm?: number; interval?: number; intervalMax?: number }
  }): void {
    const on = Boolean(state?.enabled)
    const previous = this.switchView()
    const lastChangedAt = previous.on === on ? previous.lastChangedAt : Date.now()
    this.setCapSlice(switchCapability, { on, lastChangedAt })

    // Mirror tuning fields into config so the Settings tab + the next
    // `pushConfigToFirmware` round-trip don't clobber camera-current
    // state with stale operator-typed values.
    //
    // Sensitivity is INVERSE on the wire: Reolink mobile app shows
    // user-facing 1..100 where higher = more sensitive, but the
    // camera-side `<sensiValue>` is `101 - userValue` (lower raw =
    // more sensitive). Mirrors the same convention as motion
    // sensitivity (where it's `51 - rawValue`, see
    // `refreshParentSettingsSnapshot:motionSnapshot`). Without this
    // inversion the UI shows e.g. 31 when the camera-app shows 70.
    //
    // `intervalMax` is the firmware-advertised upper bound for the
    // `interval` field — mirrored straight through (no inversion) so
    // the UI slider's `max` adapts per-cam.
    const inner = state?.state
    if (inner) {
      const patch: Record<string, unknown> = {}
      if (typeof inner.sensitive === 'number') patch['pirSensitive'] = 101 - inner.sensitive
      if (typeof inner.reduceAlarm === 'number') patch['pirReduceAlarm'] = inner.reduceAlarm === 1
      if (typeof inner.interval === 'number') patch['pirIntervalS'] = inner.interval
      if (typeof inner.intervalMax === 'number') patch['pirIntervalMax'] = inner.intervalMax
      if (Object.keys(patch).length > 0) {
        void this.config.setAll(patch).catch((err: unknown) => {
          this.ctx.logger.debug('pir config mirror failed', {
            tags: { deviceId: this.id },
            meta: { error: err instanceof Error ? err.message : String(err) },
          })
        })
      }
    }
  }

  private async refreshFromFirmware(): Promise<void> {
    try {
      const api = await this.api
      const state = await api.getPirInfo(this.channel)
      this.ctx.logger.info('pir refresh OK — firmware state', {
        tags: { deviceId: this.id },
        meta: { firmwareEnabled: state.enabled, channel: this.channel },
      })
      this.refreshSwitchFromExternal(state)
      this.hasFetchedFromFirmware = true
    } catch (err) {
      this.ctx.logger.warn('pir refresh FAILED — slice stays at cold-start seed', {
        tags: { deviceId: this.id },
        meta: { error: err instanceof Error ? err.message : String(err), channel: this.channel },
      })
    }
  }

  /**
   * Kernel-driven probe — runs at device construction (addon boot,
   * device add). For battery cams currently asleep we have two
   * cases:
   *
   *   1. **First-time probe (no cached state yet)** — force a one-shot
   *      wake + fetch. Mirrors the Reolink mobile app's launch
   *      behaviour: the app wakes the cam once at startup so the
   *      operator sees a populated UI. Without this, an aggressive
   *      sleep timeout (~14s after boot on Argus / battery doorbell
   *      firmwares) can put the cam back to sleep before the
   *      kernel's initial probe pass completes — the slice never
   *      gets populated, the kernel's retry chain exhausts after 5
   *      attempts, and the operator sees an empty PIR switch state
   *      until they manually wake the cam.
   *   2. **Subsequent probes (slice already populated)** — skip the
   *      fetch. A Baichuan poll on a sleeping camera returns 400,
   *      drains the battery, and would clobber the cached value
   *      anyway. The parent's `alignAuxDevicesState('wake')` path
   *      (simpleEvent `awake` push or sleep-poll backstop)
   *      refreshes us when the cam wakes naturally.
   *
   * Wired cams + already-awake battery cams take the normal path.
   */
  override async onProbe(): Promise<void> {
    const isSleepingBattery =
      this.parent.isBatteryCam?.() === true && this.parent.isSleeping?.() === true
    if (isSleepingBattery) {
      if (this.hasFetchedFromFirmware) {
        this.ctx.logger.debug(
          'pir onProbe skipped — parent battery cam is sleeping (have cached state)',
          {
            tags: { deviceId: this.id },
          },
        )
        return
      }
      // First-time probe: wake the cam to fetch initial state.
      // Best-effort — if wake fails we still proceed with the fetch
      // (ensureApi's login flow itself nudges the cam awake on
      // most firmwares). Mirrors `wakeForIntercom` in the parent
      // camera class (waitAfterWakeMs:2000 + 1s settle).
      this.ctx.logger.info('pir onProbe forcing wake — initial probe with no cached state', {
        tags: { deviceId: this.id },
      })
      try {
        const api = await this.api
        await api.wakeUp(this.channel, { waitAfterWakeMs: 2000 })
        await sleep(1000)
      } catch (err) {
        this.ctx.logger.warn('pir wake before initial probe failed — proceeding anyway', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    await this.refreshFromFirmware()
  }

  private registerSwitchCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      // Slice-driven read — state is written via setState, no firmware round-trip.
      getStatus: async (): Promise<SwitchStatus> => this.switchView(),
      setState: async ({ deviceId, on }) => {
        if (deviceId !== this.id) return
        // Push the FULL config on every toggle — keeps firmware in sync
        // with operator-edited sensitivity / interval values even when
        // the operator just flips on/off.
        await this.pushConfigToFirmware(on)
        this.setCapSlice(switchCapability, { on, lastChangedAt: Date.now() })
        this.lastSetAtMs = Date.now()
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    this.setCapSlice(switchCapability, { on: false, lastChangedAt: 0 })
  }

  /** One-shot push of the `SetPirInfo` payload — used both by the
   *  switch flip and the settings save. `enable` is passed explicitly
   *  so the caller controls on/off semantics; tuning fields are
   *  omitted when undefined so the lib's read-modify-write preserves
   *  the camera-current value (no false-default writes back).
   *
   *  Sensitivity inversion: config holds the user-facing 1..100
   *  (higher = more sensitive). Camera-side `<sensiValue>` is the
   *  inverse `101 - userValue` (lower raw = more sensitive).
   *  Mirrors `refreshSwitchFromExternal`'s reverse transform. */
  private async pushConfigToFirmware(enable: boolean): Promise<void> {
    const api = await this.api
    const sensitive = this.config.get('pirSensitive')
    const reduceAlarm = this.config.get('pirReduceAlarm')
    const interval = this.config.get('pirIntervalS')
    await api.setPirInfo(
      {
        enable: enable ? 1 : 0,
        ...(typeof sensitive === 'number' ? { sensitive: 101 - sensitive } : {}),
        ...(typeof reduceAlarm === 'boolean' ? { reduceAlarm: reduceAlarm ? 1 : 0 } : {}),
        ...(typeof interval === 'number' ? { interval } : {}),
      },
      this.channel,
    )
  }

  override getSettingsUISchema(): ConfigUISchemaWithValues {
    // Defaults seed only from config — config is mirrored from
    // firmware on every align refresh (`refreshSwitchFromExternal`)
    // so the form ALWAYS shows camera-current values when populated.
    // Pre-first-refresh window: fields are undefined; the form
    // renders empty and the operator should wait for the cam to
    // wake (battery) or the first probe to land (wired).
    const sensitive = this.config.get('pirSensitive')
    const interval = this.config.get('pirIntervalS')
    const reduceAlarm = this.config.get('pirReduceAlarm')
    // Per-cam upper bound for the cooldown slider. The lib parses
    // `<intervalSecMax>` from the firmware response and surfaces it
    // as `state.intervalMax`; we mirror it into config in
    // `refreshSwitchFromExternal`. Fallback `120` matches the Reolink
    // mobile app's range — every model we've probed returns 120, but
    // the dynamic mirror future-proofs against firmware that
    // advertises a lower cap. Capped at 120 to mirror the schema's
    // `.max(120)` (see `pirAccessorySchema`).
    const intervalMax = Math.min(this.config.get('pirIntervalMax') ?? 120, 120)
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 'pir',
          title: 'PIR sensor',
          titleKey: 'provider-reolink:schema.s_pir.title',
          columns: 2,
          fields: [
            {
              type: 'slider',
              key: 'pirSensitive',
              label: 'Sensitivity',
              labelKey: 'provider-reolink:schema.s_pir.pirSensitive.label',
              min: 1,
              max: 100,
              step: 1,
              ...(typeof sensitive === 'number' ? { default: sensitive } : {}),
              showValue: true,
            },
            {
              type: 'slider',
              key: 'pirIntervalS',
              label: 'Cooldown (seconds)',
              labelKey: 'provider-reolink:schema.s_pir.pirIntervalS.label',
              min: 5,
              max: intervalMax,
              step: 1,
              ...(typeof interval === 'number' ? { default: interval } : {}),
              showValue: true,
              showStepper: true,
            },
            {
              type: 'boolean',
              key: 'pirReduceAlarm',
              label: 'Reduce false alarms',
              labelKey: 'provider-reolink:schema.s_pir.pirReduceAlarm.label',
              ...(typeof reduceAlarm === 'boolean' ? { default: reduceAlarm } : {}),
              style: 'switch',
              span: 2,
            },
          ],
        },
      ],
    }
    return hydrateSchema(schema, {
      ...(typeof sensitive === 'number' ? { pirSensitive: sensitive } : {}),
      ...(typeof interval === 'number' ? { pirIntervalS: interval } : {}),
      ...(typeof reduceAlarm === 'boolean' ? { pirReduceAlarm: reduceAlarm } : {}),
    })
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    await this.config.setAll(patch)
    if ('pirSensitive' in patch || 'pirReduceAlarm' in patch || 'pirIntervalS' in patch) {
      try {
        await this.pushConfigToFirmware(this.switchView().on)
      } catch (err) {
        this.ctx.logger.warn('pir firmware push failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
        throw err
      }
    }
  }
}
