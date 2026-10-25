/**
 * OverlayDetailStateStore — in-memory per-(device,track) detail state for the
 * live-overlay re-injection (two-plane). Holds the LAST face/plate detail
 * geometry in FRAME SPACE (absolute pixels) together with its capture time.
 *
 * The overlay box is a TRUE detection, never a re-projection: the per-frame
 * synthesis (overlay-frame-builder) emits the stored frame-space bbox as-is,
 * and ONLY while it is fresh (see OVERLAY_DETAIL_FRESHNESS_MS). A periodic
 * detail cadence keeps refreshing it so the box stays glued to a moving face
 * instead of drifting off a projection onto the track's current bbox.
 *
 * Fed by `routeDetailResults`; cleaned by the same track-ended signal that
 * cleans the TrackDetailDispatcher. Identity NAMES are not stored here —
 * they live on the TrackStore active state (setLabel).
 */

export interface PixelBbox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface OverlayFaceState {
  readonly bbox: PixelBbox
  readonly score: number
  readonly capturedAt: number
}

export interface OverlayPlateState {
  readonly bbox: PixelBbox
  readonly score: number
  readonly capturedAt: number
  readonly text: string
}

export interface OverlayDetailState {
  readonly face?: OverlayFaceState
  readonly plate?: OverlayPlateState
}

function key(deviceId: number, trackId: string): string {
  return `${deviceId}:${trackId}`
}

export class OverlayDetailStateStore {
  private readonly byTrack = new Map<string, OverlayDetailState>()

  noteFaceDetail(
    deviceId: number,
    trackId: string,
    faceBbox: PixelBbox,
    score: number,
    capturedAt: number,
  ): void {
    const k = key(deviceId, trackId)
    const prev = this.byTrack.get(k)
    this.byTrack.set(k, { ...prev, face: { bbox: faceBbox, score, capturedAt } })
  }

  notePlateDetail(
    deviceId: number,
    trackId: string,
    plateBbox: PixelBbox,
    score: number,
    text: string,
    capturedAt: number,
  ): void {
    const k = key(deviceId, trackId)
    const prev = this.byTrack.get(k)
    this.byTrack.set(k, { ...prev, plate: { bbox: plateBbox, score, capturedAt, text } })
  }

  get(deviceId: number, trackId: string): OverlayDetailState | undefined {
    return this.byTrack.get(key(deviceId, trackId))
  }

  onTrackEnded(deviceId: number, trackId: string): void {
    this.byTrack.delete(key(deviceId, trackId))
  }

  clearDevice(deviceId: number): void {
    const prefix = `${deviceId}:`
    for (const k of this.byTrack.keys()) {
      if (k.startsWith(prefix)) this.byTrack.delete(k)
    }
  }

  clear(): void {
    this.byTrack.clear()
  }
}
