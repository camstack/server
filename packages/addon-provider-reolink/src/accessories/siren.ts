/**
 * SirenAccessory — child IDevice for the on-camera siren endpoint.
 *
 * Caps:
 *   - `switch`         — discrete on/off via cmd_id 30 (SetSiren)
 *   - `motion-trigger` — toggle "siren on motion" via cmd_id 231 (SetSirenOnMotion)
 *
 * Settings:
 *   - `sirenDurationS` — passed to `setSiren(on=true, duration)` on
 *                         the next switch flip (0 = play indefinitely)
 *
 * State model: every cap's last-known state lives in the runtime-state
 * slice. A 30s background poll keeps switch + motion-trigger aligned
 * with whatever the camera reports — covers Reolink-app-driven flips
 * and firmware reverts without operator action.
 */

import { z } from 'zod'
import {
  BaseDevice,
  DeviceType,
  DeviceFeature,
  hydrateSchema,
  switchCapability,
  motionTriggerCapability,
  createRuntimeStateBridge,
  type SwitchStatus,
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
import { sirenPlayDuration } from './siren-play-duration.js'
import type { ReolinkBaichuanApi } from '@apocaliss92/nodelink-js'

/** Detection-class combinations the Reolink firmware accepts for the
 *  siren-on-motion `typeScheduleList`. Mirrors `motion-floodlight`
 *  detect-type choices for `motion-siren`. */
export const SIREN_DETECT_TYPE_CHOICES = [
  'MD',
  'people',
  'vehicle',
  'dog_cat',
  'MD,people',
  'MD,vehicle',
  'MD,dog_cat',
  'people,vehicle',
  'people,dog_cat',
  'vehicle,dog_cat',
  'MD,people,vehicle',
  'MD,people,dog_cat',
  'MD,vehicle,dog_cat',
  'people,vehicle,dog_cat',
  'MD,people,vehicle,dog_cat',
] as const

export const sirenAccessorySchema = reolinkAccessoryBaseSchema.extend({
  kind: z.literal(AccessoryKind.Siren),
  /**
   * Default duration (seconds) passed to `setSiren(on=true, duration)`
   * when the operator flips the switch via the cap. `0` = play
   * indefinitely until turned off; positive value = one-shot pulse
   * for that many seconds.
   */
  sirenDurationS: z.number().int().min(0).max(300).default(0),
  /**
   * Detection classes that fire the siren when "Trigger on motion" is
   * armed. Forwarded as a `typeScheduleList` to `setSirenOnMotion`
   * (cmd_id 231). Maps to the motion-siren `typeScheduleList` field
   * + the parallel `motionLightDetectType` on Floodlight.
   * 168 = 24×7 hours per row; we set every hour to ON for the chosen
   * classes and every hour to OFF for the rest.
   */
  motionSirenDetectType: z.enum(SIREN_DETECT_TYPE_CHOICES).default('MD,people,vehicle,dog_cat'),
})

export type SirenAccessoryConfig = z.infer<typeof sirenAccessorySchema>

const STALE_MS = 30_000

/** Cooldown after operator-driven setMotionTrigger — parent's
 *  alignAuxDevicesState skips this accessory inside the window. */
const COOLDOWN_MS = 15_000

export class SirenAccessory extends BaseDevice<typeof sirenAccessorySchema> {
  readonly features = [DeviceFeature.MotionTrigger]

  private lastSetAtMs = 0
  /** Becomes `true` after the first successful
   *  `refreshMotionTriggerFromFirmware` round-trip. Used by `onProbe`
   *  to decide whether the boot-time sleep-gate should force a wake
   *  (no cached state) or skip (already-have-state path). Mirrors the
   *  Reolink mobile app's one-shot wake-and-fetch on launch. */
  private hasFetchedFromFirmware = false

  constructor(
    ctx: DeviceContext,
    private readonly parent: ReolinkAccessoryHost,
  ) {
    super(ctx, sirenAccessorySchema, {
      type: DeviceType.Siren,
      role: AccessoryKind.Siren,
    })
    this.registerSwitchCap()
    this.registerMotionTriggerCap()
    // Siren switch direct control is fire-and-forget — `getSiren`
    // returns OFF immediately after triggering, so polling would clobber
    // the UI back to OFF. We only align motion-trigger; switch state is
    // operator-driven via setState writes (the slice update inside
    // setState IS the source of truth).
    this.parent.registerAccessoryChild?.({
      kind: AccessoryKind.Siren,
      id: this.id,
      refreshFromAlign: () => this.refreshMotionTriggerFromFirmware(),
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
   *  accessory's switch / motion-trigger slices in the State panel's
   *  Raw view. `null` until at least one slice is written. */
  async getRawState(): Promise<RawStateResult | null> {
    return buildRawState(this.runtimeState)
  }

  private switchView(): SwitchStatus {
    return this.getCapSlice(switchCapability) ?? { on: false, lastChangedAt: 0 }
  }

  // Note: no `refreshSwitchFromFirmware` — see comment in constructor.
  // Siren is excluded from align because `getSiren` returns OFF
  // immediately after triggering.

  /**
   * Kernel-driven probe (Phase 4). Runs on every device construction
   * + addon restart. Pulls the actual motion-trigger enable state
   * from the camera so the slice reflects firmware truth. The switch
   * (manual fire) cap is intentionally NOT refreshed — Reolink's
   * `getSiren` returns OFF as soon as the audio task ends.
   *
   * Sleeping battery cam:
   *   1. **First-time probe (no cached state yet)** — force a one-shot
   *      wake + fetch so the operator sees a populated UI at launch.
   *      Mirrors the Reolink mobile app: at app launch it wakes the
   *      cam once to fetch initial state. Without this, an aggressive
   *      sleep timeout (~14s) can return the cam to sleep before the
   *      kernel finishes its initial probe pass — the retry chain
   *      exhausts and the slice never populates.
   *   2. **Subsequent probes (slice already populated)** — skip. A
   *      poll on a sleeping camera returns 400 and drains the
   *      battery. The parent's `alignAuxDevicesState('wake')` path
   *      (simpleEvent `awake` push or sleep-poll backstop) refreshes
   *      us when the cam wakes naturally.
   */
  override async onProbe(): Promise<void> {
    const isSleepingBattery =
      this.parent.isBatteryCam?.() === true && this.parent.isSleeping?.() === true
    if (isSleepingBattery) {
      if (this.hasFetchedFromFirmware) {
        this.ctx.logger.debug(
          'siren onProbe skipped — parent battery cam is sleeping (have cached state)',
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
      this.ctx.logger.info('siren onProbe forcing wake — initial probe with no cached state', {
        tags: { deviceId: this.id },
      })
      try {
        const api = await this.api
        await api.wakeUp(this.channel, { waitAfterWakeMs: 2000 })
        await sleep(1000)
      } catch (err) {
        this.ctx.logger.warn('siren wake before initial probe failed — proceeding anyway', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    await this.refreshMotionTriggerFromFirmware()
  }

  private async refreshMotionTriggerFromFirmware(): Promise<void> {
    try {
      const api = await this.api
      const result = await api.getSirenOnMotion(this.channel)
      // Lib emits the AudioTask block under `body.AudioTask` per the
      // typed `AudioTaskConfig`. Older builds shimmed it as either a
      // root-level `enable` or `audioTask.enable`; keep the cascading
      // probe so we work across versions without forcing a lockstep
      // upgrade.
      const audioTask = (
        result as
          | {
              body?: {
                AudioTask?: {
                  enable?: number
                  typeScheduleList?: { item?: Array<{ type?: string; valueTable?: string }> }
                }
              }
            }
          | undefined
      )?.body?.AudioTask
      const enable =
        audioTask?.enable ??
        (result as { enable?: number; audioTask?: { enable?: number } } | undefined)?.enable ??
        (result as { audioTask?: { enable?: number } } | undefined)?.audioTask?.enable
      const enabled = enable === 1
      const previous = this.getCapSlice(motionTriggerCapability)
      const lastChangedAt =
        previous && previous.enabled === enabled ? previous.lastChangedAt : Date.now()
      this.setCapSlice(motionTriggerCapability, {
        enabled,
        lastChangedAt,
        lastFetchedAt: Date.now(),
      })
      this.hasFetchedFromFirmware = true

      // Mirror `typeScheduleList` → `motionSirenDetectType` so the
      // Settings form reflects firmware truth (operator changed
      // detect classes from the Reolink app → next align refresh
      // updates camstack's UI). Inverse of `buildSirenTypeScheduleList`:
      // for each item, the type is "active" when ANY hour in its 168-
      // char `valueTable` is `'1'`. Active types ordered canonically
      // (MD,people,vehicle,dog_cat) and joined CSV.
      const items = audioTask?.typeScheduleList?.item ?? []
      if (items.length > 0) {
        const recovered = recoverSirenDetectTypeFromItems(items)
        if (
          recovered !== undefined &&
          (SIREN_DETECT_TYPE_CHOICES as readonly string[]).includes(recovered)
        ) {
          await this.config.setAll({ motionSirenDetectType: recovered }).catch((err: unknown) => {
            this.ctx.logger.debug('siren detectType mirror failed', {
              tags: { deviceId: this.id, channel: this.channel },
              meta: { error: err instanceof Error ? err.message : String(err) },
            })
          })
        } else if (recovered !== undefined) {
          this.ctx.logger.debug('siren detectType outside enum — skipping config mirror', {
            tags: { deviceId: this.id, channel: this.channel },
            meta: { recovered },
          })
        }
      }
    } catch (err) {
      this.ctx.logger.warn('siren motion-trigger fetch failed', {
        tags: { deviceId: this.id, channel: this.channel },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private registerSwitchCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      // Slice-driven read — setState updates the slice on every write;
      // no firmware refresh (getSiren returns OFF immediately).
      getStatus: async (): Promise<SwitchStatus> => this.switchView(),
      setState: async ({ deviceId, on }) => {
        if (deviceId !== this.id) return
        const api = await this.api
        const duration = sirenPlayDuration(on, this.config.get('sirenDurationS'))
        // nodelink-js signature is (channel, on, duration) at runtime —
        // the d.ts overload (on, duration, channel) is type-only and
        // misroutes the args, so the cam receives a garbled AudioAlarmPlay
        // and can flip into the SirenOnMotion AudioTask mode (visible to
        // the operator as "motion-siren active"). Always use the
        // (channel, on, duration) form so the manual switch stays manual.
        try {
          await api.setSiren(this.channel, on, duration)
        } catch (err) {
          this.ctx.logger.warn('siren setState failed', {
            tags: { deviceId: this.id, channel: this.channel },
            meta: {
              on,
              duration: duration ?? 'manual',
              error: err instanceof Error ? err.message : String(err),
            },
          })
          throw err
        }
        this.ctx.logger.info('siren setState', {
          tags: { deviceId: this.id, channel: this.channel },
          meta: { on, duration: duration ?? 'manual' },
        })
        this.setCapSlice(switchCapability, { on, lastChangedAt: Date.now() })
        // No-op for the cooldown — siren switch is never aligned, so
        // there's nothing to skip. Marking `lastSetAtMs` here would
        // also pointlessly delay the motion-trigger align.
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    this.setCapSlice(switchCapability, { on: false, lastChangedAt: 0 })
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
        const detectType = this.config.get('motionSirenDetectType') ?? 'MD,people,vehicle,dog_cat'
        this.ctx.logger.info('siren motion-trigger setMotionTrigger', {
          tags: { deviceId: this.id, channel: this.channel },
          meta: { enabled, detectType },
        })
        try {
          const api = await this.api
          if (enabled) {
            const typeScheduleList = buildSirenTypeScheduleList(detectType)
            await api.setSirenOnMotion({ enable: 1, typeScheduleList }, this.channel)
          } else {
            await api.setSirenOnMotion({ enable: 0 }, this.channel)
          }
          this.setCapSlice(motionTriggerCapability, {
            enabled,
            lastChangedAt: Date.now(),
            lastFetchedAt: Date.now(),
          })
          this.lastSetAtMs = Date.now()
        } catch (err) {
          this.ctx.logger.warn('siren motion-trigger set failed', {
            tags: { deviceId: this.id, channel: this.channel },
            meta: { enabled, error: err instanceof Error ? err.message : String(err) },
          })
          throw err
        }
      },
    }
    this.ctx.registerNativeCap(motionTriggerCapability, provider)
    const seed: MotionTriggerRuntimeState = { enabled: false, lastChangedAt: 0, lastFetchedAt: 0 }
    this.setCapSlice(motionTriggerCapability, seed)
  }

  override getSettingsUISchema(): ConfigUISchemaWithValues {
    const schema: ConfigUISchema = {
      sections: [
        {
          id: 'siren',
          title: 'Siren',
          titleKey: 'provider-reolink:schema.s_siren.title',
          description: '0 = play until turned off.',
          descriptionKey: 'provider-reolink:schema.s_siren.description',
          columns: 1,
          fields: [
            {
              type: 'number',
              key: 'sirenDurationS',
              label: 'Default duration (seconds)',
              labelKey: 'provider-reolink:schema.s_siren.sirenDurationS.label',
              default: 0,
              min: 0,
              max: 300,
              step: 1,
            },
          ],
        },
        {
          id: 'motion-siren',
          title: 'Motion-triggered siren',
          titleKey: 'provider-reolink:schema.s_motion-siren.title',
          columns: 1,
          fields: [
            {
              type: 'select',
              key: 'motionSirenDetectType',
              label: 'Detection classes',
              labelKey: 'provider-reolink:schema.s_motion-siren.motionSirenDetectType.label',
              options: SIREN_DETECT_TYPE_CHOICES.map((v) => ({
                value: v,
                label: v.replace(/,/g, ' + ').replace(/_/g, '+'),
              })),
              default: 'MD,people,vehicle,dog_cat',
            },
          ],
        },
      ],
    }
    return hydrateSchema(schema, {
      sirenDurationS: this.config.get('sirenDurationS') ?? 0,
      motionSirenDetectType:
        this.config.get('motionSirenDetectType') ?? 'MD,people,vehicle,dog_cat',
    })
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    await this.config.setAll(patch)
    // If detect-type changed AND motion-trigger is currently armed,
    // re-push to the firmware so the new filter takes effect immediately.
    if ('motionSirenDetectType' in patch) {
      const slice = this.runtimeState.getCapState<MotionTriggerRuntimeState>('motion-trigger')
      if (slice?.enabled === true) {
        const detectType =
          (patch.motionSirenDetectType as string | undefined) ??
          this.config.get('motionSirenDetectType') ??
          'MD,people,vehicle,dog_cat'
        try {
          const api = await this.api
          const typeScheduleList = buildSirenTypeScheduleList(detectType)
          await api.setSirenOnMotion({ enable: 1, typeScheduleList }, this.channel)
        } catch (err) {
          this.ctx.logger.warn('siren motion-trigger re-push after settings change failed', {
            tags: { deviceId: this.id, channel: this.channel },
            meta: { detectType, error: err instanceof Error ? err.message : String(err) },
          })
        }
      }
    }
  }
}

/** Build the `typeScheduleList` payload Reolink expects:
 *  one entry per known detection class with a 168-char (24×7) ON/OFF
 *  bitmap per detection class. */
function buildSirenTypeScheduleList(
  detectType: string,
): Array<{ type: string; valueTable: string }> {
  const types = detectType.split(',').map((t) => t.trim())
  const allOn = '1'.repeat(168)
  const allOff = '0'.repeat(168)
  return [
    { type: 'MD', valueTable: types.includes('MD') ? allOn : allOff },
    { type: 'people', valueTable: types.includes('people') ? allOn : allOff },
    { type: 'vehicle', valueTable: types.includes('vehicle') ? allOn : allOff },
    { type: 'dog_cat', valueTable: types.includes('dog_cat') ? allOn : allOff },
  ]
}

/** Inverse of `buildSirenTypeScheduleList`. Reads the camera-reported
 *  `typeScheduleList.item[]` array (cmd_id 232 GetSirenOnMotion) and
 *  recovers the canonical CSV. A type is considered ACTIVE when its
 *  168-char `valueTable` carries at least one `'1'` — `buildSirenTypeScheduleList`
 *  always writes either all-1s or all-0s, so partial rows are unexpected
 *  but treated as active (any active hour counts). Active types are
 *  emitted in canonical order (MD → people → vehicle → dog_cat) so the
 *  recovered string lines up with `SIREN_DETECT_TYPE_CHOICES`. */
function recoverSirenDetectTypeFromItems(
  items: ReadonlyArray<{ type?: string; valueTable?: string }>,
): string | undefined {
  const active = new Set<string>()
  for (const item of items) {
    if (!item.type || typeof item.valueTable !== 'string') continue
    if (item.valueTable.includes('1')) active.add(item.type)
  }
  const canonicalOrder = ['MD', 'people', 'vehicle', 'dog_cat']
  const ordered = canonicalOrder.filter((t) => active.has(t))
  return ordered.length > 0 ? ordered.join(',') : undefined
}
