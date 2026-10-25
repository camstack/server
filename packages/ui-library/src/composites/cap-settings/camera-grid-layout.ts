/**
 * The pure half of the camera-grid layout editor: what a grid IS on this side
 * of the wire, and the geometry the drag handles apply.
 *
 * Both rectangles an editor manipulates are NORMALIZED [0,1] — the crop taken
 * out of a source, and the cell it lands in. The addon stores them that way so
 * a source camera that changes resolution does not silently start cutting the
 * wrong part of the picture, and the editor has to speak the same language or
 * the conversion becomes a second place the convention can drift.
 */

export interface GridNormalizedRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface GridLayoutCell {
  readonly deviceId: number
  /** The part of the SOURCE taken, normalized against the source. */
  readonly source: GridNormalizedRect
  /** Where it lands, normalized against the CANVAS. */
  readonly cell: GridNormalizedRect
}

/**
 * Which profiles this grid can compose, and which sources stop it.
 *
 * Read-only in the editor. The operator does not choose what is on offer — the
 * source cameras do, by what they have assigned — and a checkbox that pretended
 * otherwise would publish a composition with a hole in it.
 */
export interface GridProfileOffer {
  readonly profile: 'high' | 'mid' | 'low'
  readonly offered: boolean
  readonly missingSources: readonly number[]
  /**
   * The canvas this profile composes onto, `WxH`, or empty when it is not
   * offered. DERIVED — the operator no longer types a resolution, so this is
   * the only place the grid's actual size is ever stated.
   */
  readonly canvas: string
  /**
   * Whether this profile is PUBLISHED, of the ones the grid could serve.
   *
   * A grid's `high` composes its sources' `high`, so on a 4K fleet it is a 4K
   * canvas built from 4K decodes — an opt-in, not something a viewer's adaptive
   * should be handed by climbing to the top rung it can see.
   */
  readonly published: boolean
}

export interface GridLayoutView {
  readonly instanceId: string
  readonly deviceId: number
  readonly name: string
  readonly fps: number
  readonly cells: readonly GridLayoutCell[]
  readonly profiles: readonly GridProfileOffer[]
}

/**
 * What a read of the grid can be.
 *
 * Three OUTCOMES, never two: a grid, an answer of "this device is not a grid"
 * (`null`), and a reply this page could not read (`'unreadable'`). Collapsing
 * the last two makes "not yet known" indistinguishable from "not installed",
 * which is exactly the failure D315 exists to stop.
 */
export type GridLayoutReadOutcome = GridLayoutView | null | 'unreadable'

/** Smallest rectangle the editor will produce — ffmpeg refuses a zero-area crop. */
const MIN_EXTENT = 0.02

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readRect(value: unknown): GridNormalizedRect | null {
  if (!isRecord(value)) return null
  const { x, y, width, height } = value
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return null
  }
  if (x < 0 || y < 0 || width <= 0 || height <= 0) return null
  if (x + width > 1 || y + height > 1) return null
  return { x, y, width, height }
}

function readCell(value: unknown): GridLayoutCell | null {
  if (!isRecord(value)) return null
  const deviceId = value['deviceId']
  if (typeof deviceId !== 'number' || !Number.isInteger(deviceId)) return null
  const source = readRect(value['source'])
  const cell = readRect(value['cell'])
  if (source === null || cell === null) return null
  return { deviceId, source, cell }
}

function readProfileOffer(value: unknown): GridProfileOffer | null {
  if (!isRecord(value)) return null
  const profile = value['profile']
  const offered = value['offered']
  const missing = value['missingSources']
  if (profile !== 'high' && profile !== 'mid' && profile !== 'low') return null
  if (typeof offered !== 'boolean' || !Array.isArray(missing)) return null
  const missingSources: number[] = []
  for (const entry of missing) {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) return null
    missingSources.push(entry)
  }
  // An older hub answers no canvas. Empty reads as "not stated", which the
  // editor already renders as nothing rather than as a size.
  const canvas = typeof value['canvas'] === 'string' ? value['canvas'] : ''
  // An older hub says nothing here. Reading absence as PUBLISHED keeps such a
  // hub's grid looking exactly as it behaves — it publishes what it offers.
  const published = typeof value['published'] === 'boolean' ? value['published'] : offered
  return { profile, offered, missingSources, canvas, published }
}

/**
 * Parse the `camera-grid-layout.getLayout` reply. See {@link GridLayoutReadOutcome}.
 *
 * The cap answers the view itself, or `null` — there is no envelope. It used to
 * come back as `{ grid }` from `addons.custom`, which was the mechanism the
 * widget reached the addon through before the geometry had a capability of its
 * own; the widget now asks THE CAMERA and the envelope went with the bridge.
 */
export function parseGridView(raw: unknown): GridLayoutReadOutcome {
  if (raw === null) return null
  if (!isRecord(raw)) return 'unreadable'
  const grid = raw
  // No width/height: a grid's resolution is derived per profile and reported
  // on the offers, not authored on the view.
  const { instanceId, deviceId, name, fps, cells, profiles } = grid
  if (
    typeof instanceId !== 'string' ||
    typeof deviceId !== 'number' ||
    typeof name !== 'string' ||
    typeof fps !== 'number' ||
    !Array.isArray(cells) ||
    !Array.isArray(profiles)
  ) {
    return 'unreadable'
  }
  const parsed: GridLayoutCell[] = []
  for (const entry of cells) {
    const cell = readCell(entry)
    if (cell === null) return 'unreadable'
    parsed.push(cell)
  }
  const offers: GridProfileOffer[] = []
  for (const entry of profiles) {
    const offer = readProfileOffer(entry)
    if (offer === null) return 'unreadable'
    offers.push(offer)
  }
  return { instanceId, deviceId, name, fps, cells: parsed, profiles: offers }
}

/**
 * Keep a rectangle inside the unit square.
 *
 * The addon THROWS on a rectangle that falls outside — a silently clipped
 * picture is worse than a refusal — so the editor must never hand it one.
 */
export function clampNormalizedRect(rect: GridNormalizedRect): GridNormalizedRect {
  const width = Math.min(1, Math.max(MIN_EXTENT, rect.width))
  const height = Math.min(1, Math.max(MIN_EXTENT, rect.height))
  return {
    x: Math.min(1 - width, Math.max(0, rect.x)),
    y: Math.min(1 - height, Math.max(0, rect.y)),
    width,
    height,
  }
}

/** Drag: translate by a normalized delta, clamped. */
export function moveNormalizedRect(
  rect: GridNormalizedRect,
  dx: number,
  dy: number,
): GridNormalizedRect {
  return clampNormalizedRect({ ...rect, x: rect.x + dx, y: rect.y + dy })
}

/** Resize from the bottom-right corner: the origin stays put. */
export function resizeNormalizedRect(
  rect: GridNormalizedRect,
  dw: number,
  dh: number,
): GridNormalizedRect {
  return clampNormalizedRect({ ...rect, width: rect.width + dw, height: rect.height + dh })
}

/** The eight grips on a rectangle. A corner moves two edges, an edge one. */
export type GridResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/**
 * Resize from ANY handle: the opposite side is the anchor.
 *
 * The editor had one grip, in the bottom-right, which meant a cell could only
 * grow away from its origin — to move its top edge an operator had to drag the
 * whole cell and then resize it back. The rectangle is expressed as its two
 * edges here rather than origin+extent, because that is what makes "the
 * opposite edge does not move" fall out instead of being arithmetic to get
 * wrong. `clampNormalizedRect` still has the last word: the addon THROWS on a
 * rectangle outside the unit square.
 */
export function resizeNormalizedRectFrom(
  rect: GridNormalizedRect,
  handle: GridResizeHandle,
  dx: number,
  dy: number,
): GridNormalizedRect {
  const west = handle === 'nw' || handle === 'w' || handle === 'sw'
  const east = handle === 'ne' || handle === 'e' || handle === 'se'
  const north = handle === 'nw' || handle === 'n' || handle === 'ne'
  const south = handle === 'sw' || handle === 's' || handle === 'se'

  let left = rect.x
  let right = rect.x + rect.width
  let top = rect.y
  let bottom = rect.y + rect.height

  if (west) left = Math.min(right - MIN_EXTENT, Math.max(0, left + dx))
  if (east) right = Math.max(left + MIN_EXTENT, Math.min(1, right + dx))
  if (north) top = Math.min(bottom - MIN_EXTENT, Math.max(0, top + dy))
  if (south) bottom = Math.max(top + MIN_EXTENT, Math.min(1, bottom + dy))

  return clampNormalizedRect({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  })
}

/**
 * Tile the whole canvas with `count` cells, leaving no gap.
 *
 * Autofill exists because the useful answer to "put these four cameras up" is
 * almost never the one hand-dragging produces: rectangles land a pixel apart
 * and the composition shows black seams the operator cannot see in the editor
 * but will see in the stream.
 *
 * The shape is the near-square one — `ceil(sqrt(n))` columns — and a short last
 * row STRETCHES to the full width rather than leaving a hole. Three cameras
 * become two over one, not a 2x2 with an empty quarter, which is precisely the
 * layout autofill is asked to avoid.
 *
 * Aspect is deliberately not considered: these are CANVAS fractions, and what a
 * source shows inside its cell is the crop's business (the source rectangle),
 * not the placement's. Mixing the two here would silently re-crop every cell
 * whenever the canvas was resized.
 */
export function autofillCellRects(count: number): readonly GridNormalizedRect[] {
  if (!Number.isFinite(count) || count <= 0) return []
  const cells = Math.floor(count)
  const columns = Math.ceil(Math.sqrt(cells))
  const rows = Math.ceil(cells / columns)
  const rects: GridNormalizedRect[] = []
  let placed = 0
  for (let row = 0; row < rows; row++) {
    // The last row takes what is left, so a row of one spans the full width.
    const inRow = Math.min(columns, cells - placed)
    const height = 1 / rows
    const width = 1 / inRow
    for (let column = 0; column < inRow; column++) {
      rects.push({
        x: column * width,
        y: row * height,
        width,
        height,
      })
    }
    placed += inRow
  }
  return rects
}
