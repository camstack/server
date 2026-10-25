/**
 * The recorder's motion subscription: bus → `onTrigger(deviceId, atMs)`.
 *
 * ## What is NOT here any more (2026-08-29)
 *
 * Until 2026-08-29 this file also built an `EventMarker` per event and
 * pushed it into a per-device `EventMap` — playback annotations in RAM, with
 * the provider's raw `regions` payload inside. `EventMap.events()` and
 * `EventMap.prune()` had **no caller in the whole repo**: the
 * map was only written, and grew with the runner's uptime.
 *
 * It was deleted, not wired, and the reason is in its own header: the
 * timeline the operator sees comes from the durable rows of
 * `pipelineAnalytics` (`getMotionEvents`/`getObjectEvents`/`getAudioEvents`), the
 * markers were not exposed on any cap (`recording.getPlaybackManifest`
 * returns only playlist URLs) and ADR-0194 had already explicitly refused
 * to build the trigger reconcile on top of it, because an
 * in-RAM structure survives neither the loss of the event nor the respawn of the
 * runner. A reader never existed and none was planned: keeping it
 * would have been "a leftover that describes the right design", i.e. a check
 * that checks nothing.
 *
 * What remains is the only thing anyone really read: the rising edge of
 * the motion that opens a window of the `events` band (B3).
 */
import { EventCategory } from '@camstack/types'

interface MotionData {
  readonly deviceId: number
  readonly detected: boolean
  readonly timestamp: number
}

interface BusLike {
  subscribe(
    filter: { category: string },
    handler: (event: { data: MotionData }) => void,
  ): () => void
}

export interface EventCaptureDeps {
  readonly eventBus: BusLike
  /**
   * Notified `(deviceId, triggerMs)` on each QUALIFYING motion event — the
   * recording controller uses it to open an `events`-band recording window
   * (B3). Required, not optional: it is the only reason this subscription
   * exists, and an optional callback is how a feed ends up subscribed to
   * nobody.
   */
  readonly onMotion: (deviceId: number, atMs: number) => void
}

/** Only the `detected: true` edge is a trigger. The falling edge opens
 *  nothing — the window is closed by the post-buffer, not by the event. */
export function isMotionTrigger(data: MotionData): boolean {
  return data.detected
}

export function subscribeEventCapture(deps: EventCaptureDeps): () => void {
  const { eventBus, onMotion } = deps
  return eventBus.subscribe({ category: EventCategory.MotionOnMotionChanged }, (event) => {
    if (!isMotionTrigger(event.data)) return
    onMotion(event.data.deviceId, event.data.timestamp)
  })
}
