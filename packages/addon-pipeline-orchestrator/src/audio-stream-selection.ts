/**
 * Which cam-stream a camera's AUDIO analysis rides — one pure decision.
 *
 * ## The waste this removes
 *
 * Audio had no stream of its own: `subscribeAudioStream` read
 * `config.audioStreamId ?? config.motionStreamId`, and `motionStreamId` is
 * whatever cam-stream backs the camera's MOTION profile — `low` on nearly
 * every camera of this fleet. On a camera whose `low` slot is a broker-spawned
 * `derived:*` transcode (`derived:mid-to-low`), the audio analyser therefore
 * subscribed to a TRANSCODE. And an audio subscription is broker demand:
 * `StreamBroker.hasLiveIntent()` counts `audioChunkPlane.subscriberCount`, the
 * derived feeder is spawned and torn down on that same demand edge
 * (`attachDerivedFeeder` → `onDemandChange`), so one listener that wants only
 * sound kept an ffmpeg video re-encode alive for as long as it listened. The
 * feeder's release path is correct; the audio subscriber was simply never
 * supposed to be one of its consumers.
 *
 * ## The rule
 *
 * **An audio-only consumer never causes a video transcode.** Audio attaches to
 * the camera's LOWEST NATIVE rung — `low`, else `mid`, else `high`, taking the
 * first whose cam-stream is not `derived:*`. On the cameras this was written
 * for that is `mid`, which is native, and the derived `low` feeder is released
 * the moment its last VIDEO consumer goes away.
 *
 * When no rung is native the subscription is REFUSED and says so. Spawning the
 * transcode anyway is the behaviour being removed, and silently substituting
 * is the failure `audio-subscription-refusal.spec.ts` already pins: which
 * stream a camera's audio is on must stay answerable.
 *
 * ## What the operator picks
 *
 * A rung, never a cam-stream id: `auto | high | mid | low`, stored per camera
 * and defaulting to `auto` (absent reads as `auto`, so every camera that has
 * never been touched behaves exactly as it did). `auto` IS the rule above —
 * the lowest available native rung. An explicit rung always wins, including a
 * derived one: a knob the operator set is a decision, not an accident, and it
 * is reported so the cost is visible rather than overridden.
 *
 * A pick naming a rung the camera no longer publishes is REFUSED, not quietly
 * turned back into `auto`. Substituting a stream behind the operator's back is
 * what makes "which stream is my audio on" unanswerable — the same rule the
 * audio-track refusal already obeys one step further down.
 *
 * This module is PURE. The reads it judges (the profile-slot map, the operator
 * pick) are the caller's; the log lines are the caller's too, shaped from the
 * reason this returns.
 */
import type { AudioStreamPick, CamProfile } from '@camstack/types'
import { CAM_PROFILE_ORDER } from '@camstack/types'

/**
 * Rung order for an audio consumer: cheapest first. The inverse of
 * `CAM_PROFILE_ORDER` (`high → mid → low`), derived from it rather than
 * re-spelled so the two can never disagree about which rungs exist.
 */
export const AUDIO_RUNG_PREFERENCE: readonly CamProfile[] = [...CAM_PROFILE_ORDER].reverse()

/**
 * True when a cam-stream id names a broker-spawned transcode plane.
 *
 * The `derived:` prefix is the repo-wide convention (`stream-broker-manager`'s
 * `derivedDefinition`, `snapshot-grab-pick`, `prefer-live-adaptive-candidates`,
 * the device-scoped stream pickers). Judged from the ID because that is what
 * the caller holds: the profile-slot table carries `sourceCamStreamId`, not the
 * published `CameraStream.kind`, and asking the broker for the whole stream
 * catalogue to re-derive a fact the id already states would add an RPC to every
 * audio subscribe.
 */
export function isDerivedCamStream(camStreamId: string): boolean {
  return camStreamId.startsWith('derived:')
}

/**
 * The operator's per-camera audio rung, re-exported from `@camstack/types`
 * where the schema that validates it on the wire lives. `auto` is a REAL
 * value, not an absent one: it means "the lowest available native rung", which
 * is the rule this module implements. Absent storage reads as `auto` — see
 * {@link toAudioStreamPick}.
 */
export type { AudioStreamPick }

/** Every value the per-camera setting may hold, in the order the UI offers them. */
export const AUDIO_STREAM_PICKS: readonly AudioStreamPick[] = ['auto', ...CAM_PROFILE_ORDER]

/**
 * Narrow a stored settings value to an {@link AudioStreamPick}.
 *
 * Anything that is not one of the four known values — absent, empty, a rung
 * from a schema this build does not have — reads as `auto`. That is the
 * behaviour every camera already has, so an unreadable value degrades to
 * today's rather than throwing the camera's whole detection-settings read.
 */
export function toAudioStreamPick(value: unknown): AudioStreamPick {
  return AUDIO_STREAM_PICKS.find((pick) => pick === value) ?? 'auto'
}

/** Why the selected stream is the selected stream. Log meta, not control flow. */
export type AudioStreamSelectedBy =
  /** The operator picked this rung explicitly. Honoured verbatim. */
  | 'operator-pick'
  /** The lowest rung whose cam-stream is native. */
  | 'lowest-native-rung'
  /** The motion stream, kept because the slot table could not be read and it is native anyway. */
  | 'motion-stream-fallback'

/** Why no stream could be chosen. Each value is a distinct operator-facing cause. */
export type AudioStreamRefusal =
  /** Every assigned rung of this camera is a `derived:*` transcode. */
  | 'all-rungs-derived'
  /** The slot table could not be read AND the fallback candidate is derived. */
  | 'slots-unknown-and-fallback-derived'
  /** The camera has no assigned profile slot at all. */
  | 'no-assigned-rung'
  /** The operator picked a rung this camera does not publish. */
  | 'pick-unassigned'
  /** The operator picked a rung and the slot table could not be read to resolve it. */
  | 'pick-unresolvable'

export type AudioStreamSelection =
  | {
      readonly kind: 'selected'
      readonly camStreamId: string
      /** The rung it came from — `null` only on the slot-read fallback, which has no rung. */
      readonly profile: CamProfile | null
      readonly selectedBy: AudioStreamSelectedBy
      /** True only on an operator pick that names a transcode. Reported, never overridden. */
      readonly derived: boolean
    }
  | {
      readonly kind: 'refused'
      readonly reason: AudioStreamRefusal
      /** What the operator asked for — the stored value, so the log names it. */
      readonly pick: AudioStreamPick
      /** The stream audio WOULD have ridden before this rule existed. */
      readonly rejectedCamStreamId: string | null
    }

export interface AudioStreamSelectionInput {
  /** The operator's per-camera rung. `auto` (the default) means the rule. */
  readonly pick: AudioStreamPick
  /** `config.motionStreamId` — the pre-D-rule candidate, still the fallback when it is native. */
  readonly motionStreamId: string
  /**
   * `CamProfile → sourceCamStreamId` for this device. `null` means the read
   * FAILED (transient broker RPC) — never "no slots", which is the empty map.
   * The distinction is load-bearing: an empty map is a camera with nothing
   * assigned, and a failed read must not be allowed to look like one.
   */
  readonly assigned: ReadonlyMap<CamProfile, string> | null
}

/**
 * Choose the cam-stream this camera's audio analysis attaches to.
 *
 * Pure. Every branch is either a selection carrying the reason, or a refusal
 * carrying the cause — there is no third answer and no silent default.
 */
export function selectAudioCamStream(input: AudioStreamSelectionInput): AudioStreamSelection {
  const { pick, motionStreamId, assigned } = input

  // 1. An explicit rung is a decision. Honoured even when it is derived — the
  //    caller reports that cost rather than second-guessing the operator — and
  //    REFUSED rather than quietly re-resolved when the camera no longer
  //    publishes it.
  if (pick !== 'auto') {
    if (assigned === null) {
      return { kind: 'refused', reason: 'pick-unresolvable', pick, rejectedCamStreamId: null }
    }
    const picked = assigned.get(pick)
    if (picked === undefined) {
      return { kind: 'refused', reason: 'pick-unassigned', pick, rejectedCamStreamId: null }
    }
    return {
      kind: 'selected',
      camStreamId: picked,
      profile: pick,
      selectedBy: 'operator-pick',
      derived: isDerivedCamStream(picked),
    }
  }

  // 2. The slot table could not be read. Keep today's candidate when it costs
  //    nothing; refuse when it is a transcode, because without the table there
  //    is no native rung to move to and a re-subscribe will retry the read.
  if (assigned === null) {
    if (isDerivedCamStream(motionStreamId)) {
      return {
        kind: 'refused',
        reason: 'slots-unknown-and-fallback-derived',
        pick,
        rejectedCamStreamId: motionStreamId,
      }
    }
    return {
      kind: 'selected',
      camStreamId: motionStreamId,
      profile: null,
      selectedBy: 'motion-stream-fallback',
      derived: false,
    }
  }

  // 3. The lowest NATIVE rung. `low` first — when it is native this is
  //    term-for-term the stream audio already rode, so a camera whose low rung
  //    is a real substream is unchanged.
  for (const profile of AUDIO_RUNG_PREFERENCE) {
    const camStreamId = assigned.get(profile)
    if (camStreamId === undefined) continue
    if (isDerivedCamStream(camStreamId)) continue
    return {
      kind: 'selected',
      camStreamId,
      profile,
      selectedBy: 'lowest-native-rung',
      derived: false,
    }
  }

  // 4. Nothing native. Distinguish "assigned, but every rung is a transcode"
  //    from "nothing assigned at all" — different operator actions.
  const anyAssigned = AUDIO_RUNG_PREFERENCE.some((profile) => assigned.has(profile))
  return {
    kind: 'refused',
    reason: anyAssigned ? 'all-rungs-derived' : 'no-assigned-rung',
    pick,
    rejectedCamStreamId: anyAssigned ? motionStreamId : null,
  }
}
