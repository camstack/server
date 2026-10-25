import type {
  TrackedDetection,
  TrackedObjectState,
  ZoneEvent,
  Classification,
  DetectionEvent,
  DetectionEventType,
} from '@camstack/types'
import { renameKey, renameMember } from '../tracker-v2/rename.js'
import { DEFAULT_EVENT_EMITTER_CONFIG, type EventEmitterConfig } from './event-filter.js'

export type { EventEmitterConfig } from './event-filter.js'

const STATE_TO_EVENT: Record<string, DetectionEventType> = {
  entering: 'object.entering',
  leaving: 'object.leaving',
  stationary: 'object.stationary',
  loitering: 'object.loitering',
}

const ZONE_TYPE_TO_EVENT: Record<string, DetectionEventType> = {
  'zone-enter': 'zone.enter',
  'zone-exit': 'zone.exit',
  'zone-loiter': 'zone.enter',
  'tripwire-cross': 'tripwire.cross',
}

/**
 * DetectionEventType used for the synthetic per-track APPEARANCE event
 * (Requirement 1). `object.detected` is otherwise unused by the emitter (it maps
 * from no state and no zone type), so repurposing it as the appearance marker
 * needs no new event-type vocabulary. The addon routes these into their own
 * media/persistence path and keeps them OFF the notification bus.
 */
const APPEARANCE_EVENT_TYPE: DetectionEventType = 'object.detected'

let eventIdCounter = 0

export class DetectionEventEmitter {
  private readonly config: EventEmitterConfig
  private readonly previousStates = new Map<string, string>()
  private readonly lastEmitted = new Map<string, number>()
  /**
   * Last-known track per id. A `leaving` state fires for a track that is ABSENT
   * from the current frame, so it can't be resolved from `trackMap` — it is
   * resolved from this snapshot instead (without it, leaving events never
   * fired: the latent "0 `left` events in 24h" bug).
   */
  private readonly lastKnownTracks = new Map<string, TrackedDetection>()
  /**
   * Track ids that have already been VALUED — either by a crop-bearing
   * transition/zone event or by a synthetic appearance event. Ensures a track
   * gets at most ONE appearance and never a redundant appearance on top of a
   * real crop-bearing event (Requirement 1).
   */
  private readonly valuedTracks = new Set<string>()

  constructor(config: Partial<EventEmitterConfig> = {}) {
    this.config = { ...DEFAULT_EVENT_EMITTER_CONFIG, ...config }
  }

  emit(
    tracks: readonly TrackedDetection[],
    states: readonly TrackedObjectState[],
    zoneEvents: readonly ZoneEvent[],
    classifications: readonly Classification[],
    deviceId: string,
  ): DetectionEvent[] {
    const events: DetectionEvent[] = []
    const now = Date.now()
    const stateMap = new Map(states.map((s) => [s.trackId, s]))
    const trackMap = new Map(tracks.map((t) => [t.trackId, t]))
    // Refresh the snapshot with every track seen this frame so a `leaving`
    // state (resolved below) still has a track to attach to.
    for (const t of tracks) this.lastKnownTracks.set(t.trackId, t)

    for (const state of states) {
      const track = trackMap.get(state.trackId) ?? this.lastKnownTracks.get(state.trackId)
      if (!track) continue
      if (track.trackAge < this.config.minTrackAge) continue
      // fps-independent age gate — a sub-second fragment never emits an event.
      if (state.dwellTimeMs < this.config.minTrackAgeMs) continue

      const eventType = STATE_TO_EVENT[state.state]
      if (!eventType) continue
      if (!this.config.enabledTypes.includes(eventType)) continue

      const prevState = this.previousStates.get(state.trackId)
      if (prevState === state.state) continue

      const cooldownKey = `${state.trackId}:${eventType}`
      const lastTime = this.lastEmitted.get(cooldownKey) ?? 0
      if ((now - lastTime) / 1000 < this.config.cooldownSec) continue

      this.previousStates.set(state.trackId, state.state)
      this.lastEmitted.set(cooldownKey, now)

      // A transition resolved from a PRESENT track carries a real (non-zero)
      // bbox → it's crop-bearing and values the track. A `leaving` event is
      // resolved from `lastKnownTracks` (the track is absent this frame) → NOT
      // crop-bearing, so it must not suppress the appearance fallback.
      if (trackMap.has(state.trackId)) this.valuedTracks.add(state.trackId)

      events.push({
        id: `evt-${++eventIdCounter}`,
        type: eventType,
        timestamp: now,
        deviceId,
        detection: track,
        classifications,
        objectState: state,
        zoneEvents: zoneEvents.filter((z) => z.trackId === state.trackId),
        trackPath: [...track.path],
      })
    }

    for (const ze of zoneEvents) {
      const eventType = ZONE_TYPE_TO_EVENT[ze.type]
      if (!eventType) continue
      if (!this.config.enabledTypes.includes(eventType)) continue

      // A zone event for a track that is GONE is the whole point of an
      // edge exit: the subject walked out of SHOT while inside the zone, so it
      // is absent from `tracks` by definition. Falling back to the last known
      // track mirrors what the state branch already does for `leaving` — before
      // this, such an event was built by the frame processor and silently
      // dropped right here.
      const present = trackMap.get(ze.trackId)
      const track = present ?? this.lastKnownTracks.get(ze.trackId)
      if (!track || track.trackAge < this.config.minTrackAge) continue

      const state = stateMap.get(ze.trackId)

      // Only a PRESENT track is crop-bearing. One resolved from the snapshot
      // carries a stale bbox, so it must not suppress the appearance fallback —
      // the same distinction the state branch draws for `leaving`.
      if (present) this.valuedTracks.add(ze.trackId)

      events.push({
        id: `evt-${++eventIdCounter}`,
        type: eventType,
        timestamp: now,
        deviceId,
        detection: track,
        classifications,
        objectState: state ?? {
          trackId: ze.trackId,
          state: 'moving',
          enteredAt: now,
          totalDistancePx: 0,
          dwellTimeMs: 0,
        },
        zoneEvents: [ze],
        trackPath: [...track.path],
      })
    }

    // Appearance fallback (Requirement 1): value EVERY track that passes the
    // age gate. A track present this frame that cleared the gate but produced no
    // crop-bearing event yet gets ONE synthetic appearance event carrying its
    // CURRENT bbox — so the media path captures a real crop and the track earns
    // a bestEventId. Fires at most once per track (guarded by `valuedTracks`).
    if (this.config.emitAppearance) {
      for (const track of tracks) {
        if (this.valuedTracks.has(track.trackId)) continue
        if (track.trackAge < this.config.minTrackAge) continue
        const state = stateMap.get(track.trackId)
        if (!state) continue
        if (state.dwellTimeMs < this.config.minTrackAgeMs) continue

        this.valuedTracks.add(track.trackId)
        events.push({
          id: `evt-${++eventIdCounter}`,
          type: APPEARANCE_EVENT_TYPE,
          timestamp: now,
          deviceId,
          detection: track,
          classifications,
          objectState: state,
          zoneEvents: [],
          trackPath: [...track.path],
        })
      }
    }

    for (const state of states) {
      if (state.state === 'leaving') {
        this.previousStates.delete(state.trackId)
        this.lastKnownTracks.delete(state.trackId)
        this.valuedTracks.delete(state.trackId)
      }
    }

    return events
  }

  /** D683: the continuation's emit memory moves to the survivor — no duplicate
   *  appearance event, no `leaving` for the absorbed id. */
  rename(from: string, to: string): void {
    renameKey(this.previousStates, from, to)
    renameKey(this.lastEmitted, from, to)
    renameKey(this.lastKnownTracks, from, to)
    renameMember(this.valuedTracks, from, to)
  }

  reset(): void {
    this.previousStates.clear()
    this.lastEmitted.clear()
    this.lastKnownTracks.clear()
    this.valuedTracks.clear()
  }
}
