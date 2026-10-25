/**
 * What a live overlay can draw, named once for every surface that draws it.
 *
 * The viewer and the admin UI each grew their own set of switches over the same
 * four things, with their own spellings, and a layer added to one was simply
 * missing from the other. This is the shared vocabulary: one union, one place
 * to add the fifth layer when there is one.
 *
 * ## Three of these come from the detection stream. One does not.
 *
 * `motion`, `objects` and `discarded` are all views of what the pipeline
 * emitted for THIS frame. `stationary` is not: when the evidence ledger
 * promotes a parked object, the tracker is told to FORGET it — that is the
 * whole point, it stops re-spawning tracks and events — so from that instant
 * the object is absent from the detection stream and exists only as a row of
 * the census, on the occupancy snapshot's `stationaryObjects`.
 *
 * A surface that implements `stationary` by filtering detections on
 * `track.movementState === 'idle'` therefore draws almost nothing: it can only
 * catch the narrow window between the tracker calling a track idle and the
 * ledger promoting it away (measured on device 102: 28 of 235 tracks in 24 h
 * ever reach `idle`, and the ones that park leave the stream shortly after).
 * The census is the source for this layer. Nothing else is.
 */
export type OverlayLayer = 'motion' | 'objects' | 'discarded' | 'stationary'

export const OVERLAY_LAYERS: readonly OverlayLayer[] = [
  'motion',
  'objects',
  'discarded',
  'stationary',
]

/**
 * Which layers a surface draws by default.
 *
 * `discarded` is off: it is a diagnostic — the boxes the pipeline REFUSED —
 * and on a busy camera it outnumbers everything else. The other three are on,
 * because a viewer that opens showing nothing reads as broken.
 */
export const DEFAULT_OVERLAY_LAYERS: readonly OverlayLayer[] = ['motion', 'objects', 'stationary']

/**
 * One box of the census, ready to draw: normalised to [0,1] against the frame
 * it was measured in, so a surface never needs the census's own pixel dims.
 *
 * `becameStationaryAt` is what lets a surface say "parked 3 h" — the fact an
 * operator actually reads off a parked object, and the one thing a detection
 * box can never carry.
 */
export interface StationaryOverlayBox {
  readonly id: string
  readonly className: string
  /** Normalised [0,1], same convention as a detection box. */
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly becameStationaryAt: number
  readonly label?: string
}

/**
 * How a CENSUS box is drawn — the part two renderers must agree on.
 *
 * The viewer is React Native and the admin UI is React DOM: no component can be
 * shared between them, and that is the one real wall. Everything above the
 * primitives can be, and when it is not, the two surfaces match only by a
 * hand-copied constant that the next edit desyncs in silence — which is exactly
 * what the colour table did until it was noticed.
 *
 * So the TREATMENT is data. Each side renders it in its own primitives; neither
 * side decides what it means.
 *
 * The values say what they say for a reason: a parked car is not news. An
 * overlay that draws it as loudly as a person walking in is the reason an
 * operator turns the whole overlay off. Dashed and dimmed reads as "known,
 * accounted for, not what you are looking at".
 */
export const STATIONARY_OVERLAY_STYLE = {
  /** Border width in px, at the surface's own scale. */
  borderWidth: 2,
  /** Dashed, not solid — the census is not a live detection. */
  dashed: true,
  /** Dash on/off lengths in px, for a renderer that needs them explicitly
   *  (React Native cannot express `border-dashed` without them). */
  dashPattern: [6, 4],
  /**
   * FULL opacity, deliberately.
   *
   * This was 0.7, to make a parked car quieter than a live subject. It made it
   * quieter by lying about its colour: a class hue at 70% over a dark frame
   * reads as a different hue, and the operator saw the census boxes as the
   * wrong colour — which they effectively were.
   *
   * The dash already says "censused", and it says it without touching the
   * hue. Two signals for one fact was one too many, and the one that had to go
   * is the one that corrupts a value the rest of the system agrees on: the
   * class colour comes from `EVENT_TAXONOMY` and must reach the screen intact
   * on every surface, or the palette is shared in name only.
   */
  opacity: 1,
  /** Corner radius in px. */
  borderRadius: 2,
} as const

/**
 * "3 h", "12 min", "45 s" — how long a censused object has been there.
 *
 * Coarse on purpose, and shared for the same reason the style is: nobody reads
 * a parked car to the second, a ticking label redraws an overlay for nothing,
 * and two surfaces that format it differently look like two different systems.
 *
 * A negative or non-finite age reads as `0 s` rather than throwing or printing
 * `NaN` — a clock skew between the hub that stamped it and the browser that
 * renders it must not put garbage on the screen.
 */
export function formatParkedFor(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 s'
  if (ms < 60_000) return `${String(Math.round(ms / 1000))} s`
  if (ms < 3_600_000) return `${String(Math.round(ms / 60_000))} min`
  return `${String(Math.round(ms / 3_600_000))} h`
}
