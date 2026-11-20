/**
 * Zone drawing model shared by every surface that paints detection zones: the
 * orchestrator's zone EDITOR and the read-only `ZonesReadOnlyLayer`.
 *
 * A zone is a polygon or a tripwire with normalised 0..1 points; the shared
 * drawing plane (`MaskShapeCanvas`) speaks `MaskShapeItem`. This module owns the
 * loss-less translation so no surface re-derives it:
 *   - `tripwire` -> a `line` shape (2 ordered points),
 *   - `polygon`  -> a `polygon` shape (3+ ordered points).
 */
import type { MaskPoint, MaskShape, MaskShapeKind, Zone as CapZone } from '@camstack/types'
import type { MaskShapeItem } from './../cap-settings/MaskShapeCanvas'

export type ZoneKind = 'polygon' | 'tripwire'

/** A zone as the drawing plane sees it (points, not the cap's `polygon`). */
export interface Zone {
  id: string
  name: string
  kind: ZoneKind
  color: string
  points: MaskPoint[] // normalized 0-1
}

/** Colour of a zone the cap stored without one. */
// ui-check-ok: zone colours are stored data painted on the canvas, not a theme surface
export const DEFAULT_ZONE_COLOR = '#3b82f6'

/** The shape kinds a zone can take on the drawing plane. */
export const ZONE_SHAPE_KINDS: readonly MaskShapeKind[] = ['polygon', 'line']

/** Map a drawing-plane zone onto one item of the shared canvas. */
export function zoneToItem(zone: Zone): MaskShapeItem {
  const shape: MaskShape =
    zone.kind === 'tripwire'
      ? { kind: 'line', points: zone.points }
      : { kind: 'polygon', points: zone.points }
  return { id: zone.id, label: zone.name, color: zone.color, shape }
}

/** Map a zone of the `zones` capability onto the drawing-plane model. */
export function capZoneToCanvas(zone: CapZone): Zone {
  return {
    id: zone.id,
    name: zone.name,
    kind: zone.kind,
    color: zone.color || DEFAULT_ZONE_COLOR,
    points: [...zone.polygon],
  }
}
