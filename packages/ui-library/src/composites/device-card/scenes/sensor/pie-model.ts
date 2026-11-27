/**
 * The layout of a sensor card, derived from how many readings the device has —
 * there is no setting. One reading keeps the single-measurement scene; two to six
 * are a pie of equal wedges; seven or more are a grid of tiles, one per reading
 * (a pie past six wedges stops being legible). Everything here is pure: the scene
 * only paints it.
 */
import { type HeroMeasurement, type HeroModel, isNotReported } from '@camstack/types'

/** The most readings a pie draws; one more and the card is a grid. */
export const PIE_MAX_WEDGES = 6

export type SensorLayoutInput = Pick<HeroModel, 'measurement' | 'measurements' | 'rows' | 'gated'>

export type SensorLayout =
  | { readonly kind: 'single'; readonly measurement: HeroMeasurement }
  | {
      readonly kind: 'pie'
      /** One wedge each, in order: the role's own reading first. */
      readonly shown: readonly HeroMeasurement[]
    }
  | {
      readonly kind: 'grid'
      /** One tile each, in order: the role's own reading first. */
      readonly shown: readonly HeroMeasurement[]
    }

/**
 * The layout of a sensor, or `null` when it is not drawn as a sensor card: no
 * reading, or a row the operator can still set (a sensor with controls keeps the
 * full hero card, which draws them).
 */
export function sensorLayoutOf(model: SensorLayoutInput): SensorLayout | null {
  const gated = new Set(model.gated)
  if (model.rows.some((row) => !gated.has(row.id) && row.controls.length > 0)) return null
  const all = model.measurements ?? (model.measurement === undefined ? [] : [model.measurement])
  const [only, ...rest] = all
  if (only === undefined) return null
  if (rest.length === 0) return { kind: 'single', measurement: only }
  return { kind: all.length <= PIE_MAX_WEDGES ? 'pie' : 'grid', shown: all }
}

/** What a wedge says: no data (dashed, "—"), a reading at rest, or one that is on / alarming (breathes). */
export type ReadingState = 'empty' | 'idle' | 'active'

const ACTIVE_TONES: ReadonlySet<string> = new Set(['primary', 'warning', 'danger'])

export function readingStateOf(m: HeroMeasurement): ReadingState {
  const hasData = m.reading !== null || !isNotReported(m.value)
  if (!hasData) return 'empty'
  return ACTIVE_TONES.has(m.tone) ? 'active' : 'idle'
}

export const PIE_CENTRE = 100
export const PIE_RADIUS = 96
/** How far from the centre a wedge's label sits, as a share of the radius. */
const LABEL_RADIUS_SHARE = 0.62

export interface PieWedge {
  readonly index: number
  /** Degrees clockwise from 12 o'clock. */
  readonly startDeg: number
  readonly endDeg: number
  /** The SVG path of the wedge in a 200 x 200 box. */
  readonly path: string
  /** Where the value, unit and label are centred. */
  readonly centroid: { readonly x: number; readonly y: number }
}

const point = (deg: number, radius: number): { x: number; y: number } => {
  const rad = (deg * Math.PI) / 180
  return {
    x: Number((PIE_CENTRE + radius * Math.sin(rad)).toFixed(2)),
    y: Number((PIE_CENTRE - radius * Math.cos(rad)).toFixed(2)),
  }
}

/** `count` equal wedges starting at 12 o'clock, clockwise. */
export function pieGeometry(count: number): readonly PieWedge[] {
  const step = 360 / count
  return Array.from({ length: count }, (_, index) => {
    const startDeg = index * step
    const endDeg = (index + 1) * step
    const from = point(startDeg, PIE_RADIUS)
    const to = point(endDeg, PIE_RADIUS)
    const large = step > 180 ? 1 : 0
    return {
      index,
      startDeg,
      endDeg,
      path: `M${PIE_CENTRE} ${PIE_CENTRE} L${from.x} ${from.y} A${PIE_RADIUS} ${PIE_RADIUS} 0 ${large} 1 ${to.x} ${to.y} Z`,
      centroid: point((startDeg + endDeg) / 2, PIE_RADIUS * LABEL_RADIUS_SHARE),
    }
  })
}
