/**
 * The one-shot retired-settings purges the retention pass runs first —
 * moved out of `pipeline-analytics/index.ts` verbatim (Plan B, extraction 1).
 *
 * Each purge announces a setting a decision retired (D62 retention keys, D222
 * suggestion floor, D662 face-confidence bar) and unsets it, once per device
 * per process. They are migrations, not policy: candidates for deletion once
 * the fleet's stores hold none of these keys (needs production counts first).
 */
import type { AddonContext } from '@camstack/types'
import {
  deriveSuggestionMinCosine,
  type FaceSettings,
  planStoredMinFaceConfidencePurge,
  planStoredSuggestionPurge,
  resolveFaceSettings,
  STORED_MIN_FACE_CONFIDENCE_KEY,
  STORED_SUGGESTION_MIN_COSINE_KEY,
  SUGGESTION_BAND_FACTOR,
} from '../face-settings.js'
import type { RawDeviceBlobMirror } from '../store/settings-raw-mirror.js'
import { planRetiredSettingsMigration, RETIRED_DEVICE_SETTINGS } from './retired-device-settings.js'

/** A stored `minFaceConfidence` found by the D662 purge. */
interface RetiredFaceConfidenceBar {
  readonly scope: 'global' | 'device'
  /** What the operator had typed, for the announcement. */
  readonly was: unknown
  readonly deviceId?: number
}

/** One stored suggestion floor found by the D222 purge, and the threshold that
 *  governs its band instead. `deviceId` absent ⇒ the global store. */
interface RetiredSuggestionThreshold {
  readonly scope: 'global' | 'device'
  /** What the operator had typed, for the announcement. */
  readonly was: unknown
  /** The `similarityThreshold` in force at that scope. */
  readonly threshold: number
  readonly deviceId?: number
}

/** What the purges read from the addon. Getters, because `ctx` and the
 *  settings store are bound after construction. */
export interface RetiredSettingsPurgeDeps {
  /** The addon context — throws outside the initialized window. */
  readonly ctx: () => AddonContext
  /** The addon context, or `null` outside the initialized window. */
  readonly ctxIfReady: () => AddonContext | null
  readonly readDeviceBlob: (deviceId: number) => Promise<Record<string, unknown>>
  readonly rawDeviceBlobMirror: Pick<RawDeviceBlobMirror, 'invalidate'>
  readonly resolveGlobalStore: () => Promise<Record<string, unknown>>
  readonly updateGlobalSettings: (patch: Record<string, unknown>) => Promise<void>
  readonly resolveDeviceFaceSettings: (deviceId: number) => Promise<FaceSettings>
}

export class RetiredSettingsPurge {
  constructor(private readonly deps: RetiredSettingsPurgeDeps) {}

  private get ctx(): AddonContext {
    return this.deps.ctx()
  }

  private get ctxIfReady(): AddonContext | null {
    return this.deps.ctxIfReady()
  }

  private get rawDeviceBlobMirror(): Pick<RawDeviceBlobMirror, 'invalidate'> {
    return this.deps.rawDeviceBlobMirror
  }

  private readDeviceBlob(deviceId: number): Promise<Record<string, unknown>> {
    return this.deps.readDeviceBlob(deviceId)
  }

  private resolveGlobalStore(): Promise<Record<string, unknown>> {
    return this.deps.resolveGlobalStore()
  }

  private updateGlobalSettings(patch: Record<string, unknown>): Promise<void> {
    return this.deps.updateGlobalSettings(patch)
  }

  private resolveDeviceFaceSettings(deviceId: number): Promise<FaceSettings> {
    return this.deps.resolveDeviceFaceSettings(deviceId)
  }

  /** Devices whose stored blob has already been checked for retired settings
   *  this process — the migration is a one-time announcement, not a heartbeat. */
  private readonly retiredSettingsChecked = new Set<number>()

  /**
   * One-time, per device: announce every retired retention setting the operator
   * had set, then unset it.
   *
   * The change is NOT neutral. Someone who set `retentionObjectDays: 30` is
   * moved to the track's window (7 by default) — except they had already been
   * moved, silently, when D61 made object events track-owned and the sweep
   * stopped reading the value. This warn is the only place that difference is
   * ever stated. It fires once per device (absence of the key IS the marker),
   * carries `deviceId` so it can be read per camera, and names both numbers.
   */
  async migrateRetiredRetentionSettings(deviceIds: readonly number[]): Promise<void> {
    const settings = this.ctx?.settings
    if (!settings) return
    for (const deviceId of deviceIds) {
      if (this.retiredSettingsChecked.has(deviceId)) continue
      this.retiredSettingsChecked.add(deviceId)
      try {
        const raw = await this.readDeviceBlob(deviceId)
        const plan = planRetiredSettingsMigration(raw)
        if (plan === null) continue
        for (const found of plan.retired) {
          const declared = RETIRED_DEVICE_SETTINGS.find((s) => s.key === found.key)
          this.ctx.logger.warn('analytics retention setting RETIRED — one window governs now', {
            tags: { deviceId },
            meta: {
              setting: found.key,
              wasSetTo: found.was,
              claimed: declared?.claimed,
              nowDecidedBy: declared?.nowDecidedBy,
              why: declared?.why,
              effectiveMode: plan.nowGovernedBy.retentionMode,
              effectiveWindowDays: plan.nowGovernedBy.trackRetentionDays,
            },
          })
        }
        await settings.writeDeviceStore(deviceId, plan.patch)
        this.rawDeviceBlobMirror.invalidate(deviceId)
      } catch (err) {
        // A failed migration must not stop the sweep, and must not pretend it
        // succeeded — drop the device from the checked set so the next pass
        // retries it rather than swallowing the announcement forever.
        this.retiredSettingsChecked.delete(deviceId)
        this.ctx.logger.warn('retired retention settings migration failed — will retry', {
          tags: { deviceId },
          meta: { error: String(err) },
        })
      }
    }
  }

  /** Whether the GLOBAL store has been checked for a stored suggestion floor
   *  this process, and which devices have. One announcement, not a heartbeat. */
  private storedSuggestionCheckedGlobal = false
  private readonly storedSuggestionCheckedDevices = new Set<number>()
  private storedMinFaceConfidenceCheckedGlobal = false
  private readonly storedMinFaceConfidenceCheckedDevices = new Set<number>()

  /**
   * One-time: announce the recognizer face-confidence bar D662 retired, then
   * unset it — globally and per device. Same shape as
   * {@link purgeStoredSuggestionThreshold}: absence of the key is the marker,
   * the write goes through `updateGlobalSettings` / `writeDeviceStore`, and the
   * patch unsets with `undefined`.
   *
   * Why it must leave the store and not merely go unread: the bar compared the
   * DETECTOR's score without knowing which detector produced it, so its units
   * changed under it when YuNet became the default (D645). A number left in the
   * blob is an authority the next reader who greps for it would re-adopt — at a
   * scale nobody can name. The hub carried an interim 0.85 set by hand on
   * 2026-09-27; the one bar in force is now the detector model's own floor.
   */
  async purgeStoredMinFaceConfidence(deviceIds: readonly number[]): Promise<void> {
    const settings = this.ctxIfReady?.settings
    if (!settings) return

    if (!this.storedMinFaceConfidenceCheckedGlobal) {
      this.storedMinFaceConfidenceCheckedGlobal = true
      try {
        const plan = planStoredMinFaceConfidencePurge(await this.resolveGlobalStore())
        if (plan !== null) {
          this.announceRetiredFaceConfidenceBar({ scope: 'global', was: plan.was })
          await this.updateGlobalSettings(plan.patch)
        }
      } catch (err) {
        this.storedMinFaceConfidenceCheckedGlobal = false
        this.ctx.logger.warn('face confidence bar purge failed — will retry', {
          meta: { scope: 'global', error: String(err) },
        })
      }
    }

    for (const deviceId of deviceIds) {
      if (this.storedMinFaceConfidenceCheckedDevices.has(deviceId)) continue
      this.storedMinFaceConfidenceCheckedDevices.add(deviceId)
      try {
        const plan = planStoredMinFaceConfidencePurge(await this.readDeviceBlob(deviceId))
        if (plan === null) continue
        this.announceRetiredFaceConfidenceBar({ scope: 'device', was: plan.was, deviceId })
        await settings.writeDeviceStore(deviceId, plan.patch)
        this.rawDeviceBlobMirror.invalidate(deviceId)
      } catch (err) {
        this.storedMinFaceConfidenceCheckedDevices.delete(deviceId)
        this.ctx.logger.warn('face confidence bar purge failed — will retry', {
          tags: { deviceId },
          meta: { scope: 'device', error: String(err) },
        })
      }
    }
  }

  private announceRetiredFaceConfidenceBar(found: RetiredFaceConfidenceBar): void {
    this.ctx.logger.warn(
      'face confidence bar RETIRED — the detector model floor on the runner is the one bar now',
      {
        ...(found.deviceId !== undefined ? { tags: { deviceId: found.deviceId } } : {}),
        meta: {
          scope: found.scope,
          setting: STORED_MIN_FACE_CONFIDENCE_KEY,
          wasSetTo: found.was,
          why: 'the recognizer compared the detector score without knowing which detector ran; after YuNet became the default its 0.5 was SCRFD’s bar on YuNet’s scale (D662).',
        },
      },
    )
  }

  /**
   * One-time: announce the suggestion floor D222 retired, then unset it —
   * globally and per device.
   *
   * Removing the field from the schema already makes a stored value inert
   * (`resolveFaceSettings` reads declared fields only). That is not enough. A
   * number sitting in the blob is an authority waiting to be re-adopted by the
   * next reader who greps for it, and it is what the operator last typed — so
   * it must leave the store AND be said out loud, because the value in force
   * changes: this hub carried `suggestionMinCosine: 0.33` against a 0.45
   * threshold, and the band is 0.36 from now on. Silence here would be the
   * same defect one layer up — an operator discovering three weeks later that
   * their number stopped applying.
   *
   * Absence of the key IS the marker: no flag, no version row, re-running is a
   * no-op. The write goes through `updateGlobalSettings` / `writeDeviceStore`
   * (never a raw store write), and the patch unsets with `undefined` — an
   * explicit `null` would survive the merge as exactly the residue being
   * removed.
   */
  async purgeStoredSuggestionThreshold(deviceIds: readonly number[]): Promise<void> {
    const settings = this.ctxIfReady?.settings
    if (!settings) return

    if (!this.storedSuggestionCheckedGlobal) {
      this.storedSuggestionCheckedGlobal = true
      try {
        const plan = planStoredSuggestionPurge(await this.resolveGlobalStore())
        if (plan !== null) {
          const global = resolveFaceSettings(await this.resolveGlobalStore())
          this.announceRetiredSuggestionThreshold({
            scope: 'global',
            was: plan.was,
            threshold: global.similarityThreshold,
          })
          await this.updateGlobalSettings(plan.patch)
        }
      } catch (err) {
        // Retry next pass rather than swallow the announcement forever.
        this.storedSuggestionCheckedGlobal = false
        this.ctx.logger.warn('face suggestion threshold purge failed — will retry', {
          meta: { scope: 'global', error: String(err) },
        })
      }
    }

    for (const deviceId of deviceIds) {
      if (this.storedSuggestionCheckedDevices.has(deviceId)) continue
      this.storedSuggestionCheckedDevices.add(deviceId)
      try {
        const plan = planStoredSuggestionPurge(await this.readDeviceBlob(deviceId))
        if (plan === null) continue
        const effective = await this.resolveDeviceFaceSettings(deviceId)
        this.announceRetiredSuggestionThreshold({
          scope: 'device',
          was: plan.was,
          threshold: effective.similarityThreshold,
          deviceId,
        })
        await settings.writeDeviceStore(deviceId, plan.patch)
        this.rawDeviceBlobMirror.invalidate(deviceId)
      } catch (err) {
        this.storedSuggestionCheckedDevices.delete(deviceId)
        this.ctx.logger.warn('face suggestion threshold purge failed — will retry', {
          tags: { deviceId },
          meta: { scope: 'device', error: String(err) },
        })
      }
    }
  }

  /** The one line the operator can read to see what their number became. Both
   *  numbers, and the rule between them, or it does not explain anything. */
  private announceRetiredSuggestionThreshold(found: RetiredSuggestionThreshold): void {
    this.ctx.logger.warn(
      'face suggestion threshold RETIRED — it is derived from the match threshold now',
      {
        ...(found.deviceId !== undefined ? { tags: { deviceId: found.deviceId } } : {}),
        meta: {
          scope: found.scope,
          setting: STORED_SUGGESTION_MIN_COSINE_KEY,
          wasSetTo: found.was,
          similarityThreshold: found.threshold,
          bandFactor: SUGGESTION_BAND_FACTOR,
          nowInForce: deriveSuggestionMinCosine(found.threshold),
          why: 'two knobs over one band could disagree, and did — a 0.45 threshold against a 0.50 floor made the suggestion band [0.50, 0.45) empty, so nothing could be suggested at all (D222).',
        },
      },
    )
  }
}
