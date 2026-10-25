/**
 * Zone crossings for a tracked subject — the events that never existed.
 *
 * ## What was missing
 *
 * `zone.enter` / `zone.exit` are declared in the event vocabulary
 * (`event-emitter.ts`) and in the cap types, and the emitter has a whole branch
 * that turns them into events. Nothing ever produced one: the frame processor
 * called `emit(tracks, states, [], [], deviceId)` with a literal empty array and
 * a comment calling zone events "a follow-up".
 *
 * The consequence was invisible and total. A notification rule scoped to a zone
 * could only fire if a MOVEMENT-state transition (entering / leaving /
 * stationary / loitering) happened to occur on a frame where the box overlapped
 * the zone. A subject that simply walked through — no state change — produced
 * nothing at all. Measured on 2026-07-31: a person at 0.889 confidence crossed
 * device 101's "Uscio" zone and the rule scoped to exactly that never matched.
 *
 * ## Hysteresis is not optional
 *
 * Zone membership is geometric and jitters at the boundary: a bbox that wobbles
 * by a few pixels crosses in and out on consecutive frames. Emitting a raw
 * transition per frame would produce a burst of enter/exit for one subject
 * standing on the edge — and each of those is a notification.
 *
 * So a crossing must PERSIST to count. Entry and exit have deliberately
 * different bars: an entry is what the operator wants to hear about, so it is
 * confirmed quickly; an exit only ends a presence, so it waits longer and a
 * momentary occlusion does not end it.
 *
 * This complements, and does not replace, the overlap threshold
 * (`zoneMembershipMinOverlap`): that decides how much of the box must be inside
 * to count as inside at all, this decides how long that must hold.
 */

import { renameKey } from '../tracker-v2/rename.js'

/** Consecutive frames inside before an entry is real. */
export const DEFAULT_ENTER_FRAMES = 2
/** Consecutive frames outside before an exit is real — deliberately laxer. */
export const DEFAULT_EXIT_FRAMES = 4

export interface ZoneTransitionConfig {
  readonly enterFrames: number
  readonly exitFrames: number
}

const DEFAULT_ZONE_TRANSITION_CONFIG: ZoneTransitionConfig = {
  enterFrames: DEFAULT_ENTER_FRAMES,
  exitFrames: DEFAULT_EXIT_FRAMES,
}

/** Confirmed crossings for one track on one frame. */
export interface ZoneTransitions {
  readonly entered: readonly string[]
  readonly exited: readonly string[]
}

const NO_TRANSITIONS: ZoneTransitions = { entered: [], exited: [] }

interface TrackZoneState {
  /** Zones the track is CONFIRMED to be inside. */
  readonly inside: Set<string>
  /** Consecutive frames seen inside a zone not yet confirmed. */
  readonly enterStreak: Map<string, number>
  /** Consecutive frames seen outside a zone still confirmed. */
  readonly exitStreak: Map<string, number>
}

function newState(): TrackZoneState {
  return { inside: new Set(), enterStreak: new Map(), exitStreak: new Map() }
}

export class ZoneTransitionTracker {
  private readonly config: ZoneTransitionConfig
  private readonly tracks = new Map<string, TrackZoneState>()

  constructor(config: Partial<ZoneTransitionConfig> = {}) {
    this.config = { ...DEFAULT_ZONE_TRANSITION_CONFIG, ...config }
  }

  /**
   * Feed one frame's zone membership for one track.
   *
   * `currentZoneIds` is the set the geometry says the box is in RIGHT NOW; the
   * return value is only what has persisted long enough to be believed.
   */
  observe(trackId: string, currentZoneIds: readonly string[]): ZoneTransitions {
    const state = this.tracks.get(trackId) ?? newState()
    this.tracks.set(trackId, state)

    const now = new Set(currentZoneIds)
    const entered: string[] = []
    const exited: string[] = []

    // Candidates for entry: seen inside, not yet confirmed.
    for (const zoneId of now) {
      if (state.inside.has(zoneId)) {
        // Still inside — any pending exit is cancelled outright, not decayed:
        // an occlusion that ends must not leave the subject half-way out.
        state.exitStreak.delete(zoneId)
        continue
      }
      const streak = (state.enterStreak.get(zoneId) ?? 0) + 1
      if (streak >= this.config.enterFrames) {
        state.enterStreak.delete(zoneId)
        state.inside.add(zoneId)
        entered.push(zoneId)
      } else {
        state.enterStreak.set(zoneId, streak)
      }
    }

    // A zone left this frame breaks any entry streak it had going.
    for (const zoneId of [...state.enterStreak.keys()]) {
      if (!now.has(zoneId)) state.enterStreak.delete(zoneId)
    }

    // Candidates for exit: confirmed inside, not seen this frame.
    for (const zoneId of [...state.inside]) {
      if (now.has(zoneId)) continue
      const streak = (state.exitStreak.get(zoneId) ?? 0) + 1
      if (streak >= this.config.exitFrames) {
        state.exitStreak.delete(zoneId)
        state.inside.delete(zoneId)
        exited.push(zoneId)
      } else {
        state.exitStreak.set(zoneId, streak)
      }
    }

    if (entered.length === 0 && exited.length === 0) return NO_TRANSITIONS
    return { entered, exited }
  }

  /** Zones a track is currently confirmed to be inside. */
  zonesFor(trackId: string): readonly string[] {
    const state = this.tracks.get(trackId)
    return state ? [...state.inside] : []
  }

  /**
   * Drop a track and report the zones it was still inside.
   *
   * The caller uses these to close the subject's presence — a track that
   * disappears mid-zone has genuinely left it, and nothing else will ever say
   * so. Without this, a zone entry would have no matching exit whenever the
   * subject walked out of frame rather than out of the zone.
   */
  forget(trackId: string): readonly string[] {
    const state = this.tracks.get(trackId)
    if (!state) return []
    this.tracks.delete(trackId)
    return [...state.inside]
  }

  /** D683: zone membership continues under the survivor id. */
  rename(from: string, to: string): void {
    renameKey(this.tracks, from, to)
  }

  /** Number of tracks held — a leak check for the caller's tests. */
  size(): number {
    return this.tracks.size
  }
}
