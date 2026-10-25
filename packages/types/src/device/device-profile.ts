/**
 * Bindings × Modes contract
 * ─────────────────────────
 *
 * Two independent layers gate every analyzer phase (detection / audio):
 *
 *   1. **Bindings** (low-level wiring, escape hatch)
 *      The cap-router decides whether the addon is MOUNTED for a
 *      device at all. `setWrapperActive(deviceId, capName, false)`
 *      fully dismounts the cap; nothing the cap exposes (provider
 *      methods, runtime-state, events) is reachable. The operator
 *      rarely touches this from the UI — it's the "uninstall this
 *      addon for this device" button. Default: every wrapper bound.
 *
 *   2. **Modes** (operator-facing scheduling)
 *      The `detectionMode` / `audioMode` selectors decide WHEN the
 *      mounted cap actually fires. `'disabled'` is the runtime-level
 *      off switch — the cap stays mounted, schema present, RPCs
 *      callable, but the runner / orchestrator skip the substream
 *      subscriber. The other 2 modes (`'always-on'`, `'on-motion'`)
 *      drive when the subscribe + analyze cycle runs.
 *
 * **AND-gate semantics**: a phase fires iff `(binding bound) AND
 * (mode != 'disabled')`. Either layer disables → cap inactive.
 * Neither layer overrides the other; the operator picks whichever
 * lever maps to their intent.
 *
 *   - "I never want SW detection on this camera" → unbind via
 *     bindings UI (extreme — also disables the cap surface).
 *   - "Pause detection for now, keep wired" → set
 *     `detectionMode = 'disabled'`. Settings still surface; no
 *     substream demand.
 *   - "Detection only when motion fires" → `detectionMode = 'on-motion'`,
 *     binding stays bound.
 *
 * Profile defaults populate modes when the operator hasn't picked.
 * Bindings are bound by their wrappers' `defaultActive: true` flag,
 * unaffected by the profile.
 *
 * ─────────────────────────
 *
 * DeviceProfile — declarative defaults applied to devices that match a
 * feature predicate.
 *
 * Solves the "battery cams shouldn't run continuous analyzers" problem
 * (and adjacent policy questions like low-bandwidth fallback) by
 * centralising the operator-facing defaults in ONE place. The profile
 * does NOT touch capability bindings — those stay as the low-level
 * wiring escape hatch. Instead the profile drives the per-device
 * pipeline behaviour through three operator-visible "mode" knobs that
 * the runner / orchestrator interpret directly.
 *
 *   - `motionSources` — already a per-device setting today; the profile
 *     just supplies a sensible default (`['onboard']` when firmware
 *     motion is available; `[]` otherwise so a battery cam with no PIR
 *     and no firmware push gates everything off until the operator opts
 *     into `'analyzer'` SW motion).
 *
 *   - `audioMode` (NEW) — selects when the audio classifier runs:
 *     `'disabled'`, `'always-on'`, `'on-motion'`. Replaces the implicit
 *     "audio runs when wrapper bound" behaviour. Wrappers stay bound;
 *     the addon reads this mode at runtime to decide whether to
 *     subscribe to the audio decoded stream.
 *
 *   - `detectionMode` (NEW) — selects when object detection runs:
 *     `'disabled'`, `'always-on'`, `'on-motion'`. Mirrors `audioMode`
 *     and replaces the legacy `priority: 'default'|'always-on'` toggle
 *     with explicit semantics.
 *
 * ─── Sticky-by-construction ───────────────────────────────────────────
 *
 * Nothing in the runtime re-applies a profile. Operator changes always
 * win because the persistence layer captures them as concrete entries
 * (config blob value); the profile is consulted only when no entry
 * exists yet. If a setting is absent from the blob the resolver falls
 * back to the profile's default, then the schema's static default.
 */
import type { DeviceFeature } from './device-type.js'
import { DeviceFeature as Feature } from './device-type.js'

/**
 * Match clause: the profile applies to a device iff its `features`
 * array contains `hasFeature`. Single-feature gate keeps matching
 * cheap; the profile-stack iterates in order and the first match wins.
 */
export interface DeviceProfileMatch {
  readonly hasFeature: DeviceFeature
}

/**
 * When-mode selector for analyzer phases (audio classification, object
 * detection). `'disabled'` keeps the addon idle; `'always-on'` runs
 * continuously; `'on-motion'` activates only when the motion-gate is
 * open (firmware motion event OR analyzer-derived motion).
 */
export type PipelinePhaseMode = 'disabled' | 'always-on' | 'on-motion'

/**
 * Operator-facing settings the profile populates at creation time +
 * resolver fallback time. These are NOT tightly bound to a single
 * config schema field — the resolver (in pipeline-orchestrator) reads
 * them when computing the runner config, and persists operator changes
 * back to the same keys via the existing per-device store.
 */
export interface DeviceProfileDefaults {
  /** Default `motionSources` array when the operator hasn't picked
   *  one. Empty array means "no motion source" — useful for battery
   *  cams without firmware motion (operator opts into `'analyzer'`
   *  explicitly to enable SW motion). PIR-sourced motion currently
   *  flows through `'onboard'` because Reolink's accessory PIRs feed
   *  the parent camera's firmware motion event channel. */
  readonly motionSources?: import('../capabilities/pipeline-runner.cap.js').MotionSources
  readonly audioMode?: PipelinePhaseMode
  readonly detectionMode?: PipelinePhaseMode
}

export interface DeviceProfile {
  readonly id: string
  readonly label: string
  readonly when: DeviceProfileMatch
  /**
   * Default phase modes + motion-source pick. Resolver reads these
   * when no operator value is persisted; profile never overrides a
   * concrete operator choice.
   */
  readonly defaults: DeviceProfileDefaults
  /**
   * Generic settings overrides, keyed by dot-path, intended to be
   * interpreted by the per-driver / per-addon config schema.
   *
   * **Nothing reads this today.** It is a declared extension point with no
   * consumer anywhere in the workspace, so any entry placed here is inert. It
   * shipped populated — `snapshot.minRefreshIntervalSec: 3600` and
   * `streamBroker.preBufferEnabled: false` on the battery profile — which read
   * as live policy and were not: both behaviours are really enforced off
   * `DeviceFeature.BatteryOperated` directly, by `BATTERY_DEFAULT_MAX_AGE_S`
   * in `snapshot.addon.ts` and by `getEffectivePreBufferSec` in
   * `stream-broker-manager.ts`. Emptied 2026-08-07; keep it empty until a
   * reader exists, or an entry here is just documentation that lies.
   */
  readonly settings: Readonly<Record<string, unknown>>
}

/**
 * Heuristic check — `device.features?.includes(profile.when.hasFeature)`.
 */
export function deviceMatchesProfile(
  features: readonly string[] | undefined,
  profile: DeviceProfile,
): boolean {
  if (!features || features.length === 0) return false
  return features.includes(profile.when.hasFeature)
}

/**
 * Battery-operated cameras default policy. The substream stays dialed
 * only when there's something for the runner to actually process —
 * audio is off, detection only runs on motion.
 *
 * `motionSources` is NOT in the profile defaults: the orchestrator's
 * resolver already prefers `'onboard'` whenever the device exposes a
 * native motion cap (firmware-driven motion), independent of profile.
 * Battery cams without firmware motion fall back to `[]` (no source) —
 * the operator must opt into `'analyzer'` SW motion explicitly.
 *
 * Object detection on motion: when motion fires, the runner attaches
 * the substream + runs detection until the motion gate closes, then
 * releases. Firmware idle-disconnect fires shortly after, the camera
 * goes back to sleep.
 */
export const BATTERY_DEVICE_PROFILE: DeviceProfile = {
  id: 'battery',
  label: 'Battery-operated camera',
  when: { hasFeature: Feature.BatteryOperated },
  defaults: {
    audioMode: 'disabled',
    detectionMode: 'on-motion',
  },
  // Empty on purpose — see `DeviceProfile.settings`. The snapshot interval and
  // the pre-buffer flag that used to sit here were never read; both are
  // enforced off `DeviceFeature.BatteryOperated` at the addon that owns them.
  settings: {},
}

/**
 * Profile registry — order matters when multiple profiles match the
 * same device (first match wins). Today there's only one entry.
 */
export const DEVICE_PROFILES: readonly DeviceProfile[] = [BATTERY_DEVICE_PROFILE]

/**
 * Resolve the profile that matches a device's features, or `null` when
 * no profile matches. First-match-wins.
 */
export function resolveDeviceProfile(
  features: readonly string[] | undefined,
): DeviceProfile | null {
  for (const profile of DEVICE_PROFILES) {
    if (deviceMatchesProfile(features, profile)) return profile
  }
  return null
}
