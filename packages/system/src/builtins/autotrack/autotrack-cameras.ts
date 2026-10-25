/**
 * What this addon persists per camera, and how the cap's cross-vendor settings
 * become this loop's tuning.
 *
 * ## Why the record lives here and not in the cap's runtime state
 *
 * `ptz-autotrack` declares `durability: 'session'` — its slice MIRRORS a
 * camera's own autotrack config and is re-read on connect. For a native
 * provider that is right: the firmware is the record. For the emulated
 * implementation there is no firmware to re-read, so the slice would come back
 * empty on every restart and a camera the operator armed would come up
 * disarmed, silently. The record is therefore ours, in the addon's own
 * settings, and the cap's `getStatus` reads it.
 *
 * ## One switch, not two (D62, D520)
 *
 * Binding this wrapper to a camera chooses the IMPLEMENTATION.
 * `setEnabled` is the switch for the function, and
 * it is the cap's own switch: a camera with firmware autotrack uses its native
 * provider for exactly the same method, so the operator never sees two
 * controls that can disagree.
 */
import { FIRST_LEVEL_MACRO_CLASSES, type FirstLevelMacroClass } from '@camstack/types'
import type { PtzAutotrackSettings, PtzAutotrackStatus } from '@camstack/types'
import { type AutotrackLoopConfig, DEFAULT_AUTOTRACK_LOOP_CONFIG } from './autotrack-config.js'

/**
 * How much of the frame the subject SHOULD occupy, and nothing else about zoom.
 *
 * Hidden on purpose (operator, 2026-09-18: *"rendiamo lo zoom configurabile,
 * nascosto per ora, ci lavoriamo poi quando ne vedo il bisogno"* [let us make the zoom configurable, hidden for now, we will work on it later when I see the need]). It is not in
 * `PtzAutotrackSettings` — that schema is the cross-vendor surface the device
 * page renders, and putting it there would SHOW a control nothing implements.
 * It lives in this addon's own record instead: settable, persisted, invisible.
 *
 * `null` means the loop does not touch zoom at all, which is what every camera
 * gets until somebody decides otherwise.
 */
export interface AutotrackZoomSetting {
  /**
   * Target share of the frame for the tracked subject's box, `0..1`.
   *
   * The operator's original ask was "keep the target at about 50% of frame",
   * so 0.5 is the number this exists to hold. It is a FRACTION OF AREA on the
   * frame the loop measures in, not a zoom level: the loop is declaredly
   * visual and never learns where the optics are (D520).
   */
  readonly targetSubjectFraction: number | null
}

/** One camera's record. */
export interface AutotrackCameraRecord {
  readonly enabled: boolean
  readonly settings: PtzAutotrackSettings
  readonly zoom: AutotrackZoomSetting
}

/** deviceId → record. */
export type AutotrackCameraRecords = Readonly<Record<number, AutotrackCameraRecord>>

/**
 * The defaults a camera starts from.
 *
 * `disappearDelaySeconds` matches the loop's own default so the two cannot
 * disagree on the day nobody has opened the form. `stopDelaySeconds` is
 * persisted and NOT honoured — see {@link loopConfigFor}.
 */
export const DEFAULT_CAMERA_RECORD: AutotrackCameraRecord = {
  enabled: false,
  settings: {
    targetType: '',
    stopDelaySeconds: 30,
    disappearDelaySeconds: DEFAULT_AUTOTRACK_LOOP_CONFIG.disappearDelayMs / 1000,
  },
  zoom: { targetSubjectFraction: null },
}

/**
 * What this implementation can follow, as the cap's target options.
 *
 * A vendor list would be a lie here: the emulated loop follows what the
 * DETECTOR emits, and the detector's first-level macro classes are these
 * three. Reolink's `people` and Hikvision's `human` are vendor words for the
 * same thing and are normalised in {@link targetClassFor} rather than offered.
 */
export const EMULATED_TARGET_OPTIONS: PtzAutotrackStatus['supportedTargetTypes'] =
  FIRST_LEVEL_MACRO_CLASSES.map((macro) => ({
    value: macro,
    label: macro === 'person' ? 'People' : macro === 'vehicle' ? 'Vehicles' : 'Animals',
  }))

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSettings(raw: unknown): PtzAutotrackSettings {
  if (!isRecordObject(raw)) return DEFAULT_CAMERA_RECORD.settings
  const targetType = raw['targetType']
  const stopDelaySeconds = raw['stopDelaySeconds']
  const disappearDelaySeconds = raw['disappearDelaySeconds']
  return {
    targetType:
      typeof targetType === 'string' ? targetType : DEFAULT_CAMERA_RECORD.settings.targetType,
    stopDelaySeconds:
      typeof stopDelaySeconds === 'number' && Number.isFinite(stopDelaySeconds)
        ? stopDelaySeconds
        : DEFAULT_CAMERA_RECORD.settings.stopDelaySeconds,
    disappearDelaySeconds:
      typeof disappearDelaySeconds === 'number' && Number.isFinite(disappearDelaySeconds)
        ? disappearDelaySeconds
        : DEFAULT_CAMERA_RECORD.settings.disappearDelaySeconds,
  }
}

/**
 * Read the persisted blob.
 *
 * A malformed ENTRY falls back to the defaults and keeps its `enabled` flag —
 * it is never dropped. Dropping it would disarm a function the operator armed,
 * which is the one direction this must not fail in; a camera that is not in
 * the blob at all is simply a camera nobody has switched on.
 */
/**
 * Read the hidden zoom setting.
 *
 * Out-of-range is CLAMPED into the unit interval rather than carried: a control
 * loop that eventually reads this must never be handed a 4, and a silently
 * dropped value would look like "the operator never set it".
 */
function parseZoom(raw: unknown): AutotrackZoomSetting {
  if (!isRecordObject(raw)) return { targetSubjectFraction: null }
  const value = raw['targetSubjectFraction']
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return { targetSubjectFraction: null }
  }
  return { targetSubjectFraction: Math.min(1, value) }
}

/**
 * Why this camera's zoom request is not being honoured, or `null` when it asked
 * for nothing.
 *
 * A setting that is read and ignored in silence is indistinguishable from a
 * broken one, and this one WILL be read by a loop that cannot act on it yet.
 * So asking for it produces a sentence naming the number and what is missing.
 */
export function zoomRefusalFor(record: AutotrackCameraRecord): string | null {
  const target = record.zoom.targetSubjectFraction
  if (target === null) return null
  return (
    `autotrack zoom is configured (target subject fraction ${String(target)}) but NOT IMPLEMENTED: ` +
    'the loop drives pan and tilt only. Subject-size control needs a third axis with its own dead ' +
    'band, a rule that it may act only while pan/tilt are settled, and two calibration measurements ' +
    'first — a stale error costs more the further the optics are zoomed in.'
  )
}

export function parseCameraRecords(raw: unknown): AutotrackCameraRecords {
  if (!isRecordObject(raw)) return {}
  const out: Record<number, AutotrackCameraRecord> = {}
  for (const [key, value] of Object.entries(raw)) {
    const deviceId = Number(key)
    if (!Number.isInteger(deviceId) || deviceId <= 0) continue
    if (!isRecordObject(value)) continue
    out[deviceId] = {
      enabled: value['enabled'] === true,
      settings: parseSettings(value['settings']),
      zoom: parseZoom(value['zoom']),
    }
  }
  return out
}

/** Immutable per-camera patch — a NEW map, the previous one untouched. */
export function withCameraPatch(
  records: AutotrackCameraRecords,
  deviceId: number,
  patch: {
    enabled?: boolean
    settings?: Partial<PtzAutotrackSettings>
    zoom?: Partial<AutotrackZoomSetting>
  },
): AutotrackCameraRecords {
  const current = records[deviceId] ?? DEFAULT_CAMERA_RECORD
  return {
    ...records,
    [deviceId]: {
      enabled: patch.enabled ?? current.enabled,
      settings: { ...current.settings, ...patch.settings },
      zoom: { ...current.zoom, ...patch.zoom },
    },
  }
}

/**
 * The detection macro class this camera follows.
 *
 * `''` is the cap's "camera default" and means PERSON here — the class an
 * autotrack is asked for in almost every case, and the one the measurement
 * slice used. A vendor string (`people`, `human`) normalises to the macro it
 * names; anything else falls back to person rather than following nothing,
 * because a loop that silently follows nothing is indistinguishable from one
 * that is broken.
 */
export function targetClassFor(settings: PtzAutotrackSettings): FirstLevelMacroClass {
  const raw = settings.targetType.trim().toLowerCase()
  if (raw === '') return 'person'
  for (const macro of FIRST_LEVEL_MACRO_CLASSES) {
    if (raw === macro) return macro
  }
  if (raw === 'people' || raw === 'human' || raw === 'humans') return 'person'
  if (raw === 'vehicles' || raw === 'car' || raw === 'motor_vehicle') return 'vehicle'
  if (raw === 'pet' || raw === 'pets' || raw === 'dog' || raw === 'cat') return 'animal'
  return 'person'
}

/**
 * The loop's config for this camera.
 *
 * Only ONE of the cap's three settings reaches the loop:
 *
 * - `disappearDelaySeconds` → {@link AutotrackLoopConfig.disappearDelayMs}. Same
 *   meaning on both sides: how long a target that stopped appearing is held
 *   before it is released and the head goes home.
 * - `targetType` → the detection class, through {@link targetClassFor}.
 * - `stopDelaySeconds` is persisted and NOT honoured. It means "keep tracking a
 *   STATIONARY target for this long before stopping", and a pulse-based loop
 *   already does nothing while the subject is inside the dead zone — there is
 *   no motion to stop. Storing it and ignoring it is deliberate: the cap is
 *   cross-vendor, a native provider honours it, and dropping it from the
 *   payload would make a camera that switches from native to emulated lose a
 *   setting it had. It is reported back by `getStatus` verbatim, never as a
 *   number this loop acted on.
 *
 * Everything else in the loop config is a TUNING CONSTANT that D520 kept out of
 * the operator surface on purpose (dead zone, settle zone, command ceiling,
 * pulse dead time). They stay constants.
 */
export function loopConfigFor(settings: PtzAutotrackSettings): AutotrackLoopConfig {
  return {
    ...DEFAULT_AUTOTRACK_LOOP_CONFIG,
    disappearDelayMs: Math.max(0, Math.round(settings.disappearDelaySeconds * 1000)),
  }
}

/** The cap's status for one camera. */
export function statusFor(
  record: AutotrackCameraRecord,
  lastChangedAt: number,
): PtzAutotrackStatus {
  return {
    enabled: record.enabled,
    lastChangedAt,
    currentSettings: record.settings,
    supportedTargetTypes: EMULATED_TARGET_OPTIONS,
  }
}
