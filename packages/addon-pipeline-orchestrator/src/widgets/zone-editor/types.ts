/**
 * Zone-editor domain model + mapping onto the shared drawing plane.
 *
 * The orchestrator speaks in `Zone`s (`polygon` | `tripwire`, normalized
 * 0..1 points). The on-frame editor is the shared `MaskShapeCanvas` from
 * `@camstack/ui-library`, which speaks `MaskShape` / `MaskShapeItem`. This
 * module owns BOTH the domain types (so `ZoneList` / `ZoneForm` / `ZonesTab`
 * keep their model after the bespoke `ZoneCanvas` was removed) and the
 * loss-less `Zone ⇄ MaskShapeItem` translation:
 *
 *   - `tripwire` ⇄ a `line` shape (2 ordered points).
 *   - `polygon`  ⇄ a `polygon` shape (≥3 ordered points).
 *
 * Every `Zone.points` entry is already a `{ x, y }` normalized point, which is
 * structurally a `MaskPoint`, so the round-trip never reshapes coordinates.
 */
import type { MaskShape, MaskShapeKind, MaskPoint } from '@camstack/types'
import type { MaskShapeItem } from '@camstack/ui-library'

export type ZoneKind = 'polygon' | 'tripwire'

export interface Zone {
  id: string
  name: string
  kind: ZoneKind
  color: string
  points: MaskPoint[] // normalized 0-1
}

/** Map a domain `Zone` onto one editable item on the shared drawing plane. */
export function zoneToItem(zone: Zone): MaskShapeItem {
  const shape: MaskShape =
    zone.kind === 'tripwire'
      ? { kind: 'line', points: zone.points }
      : { kind: 'polygon', points: zone.points }
  return { id: zone.id, label: zone.name, color: zone.color, shape }
}

/** The domain kind a freshly-drawn shape maps back to. */
export function shapeKindToZoneKind(kind: MaskShapeKind): ZoneKind {
  return kind === 'line' ? 'tripwire' : 'polygon'
}

/** The drawing-plane kind for a given drawing-mode zone kind. */
export function zoneKindToDrawingKind(kind: ZoneKind): MaskShapeKind {
  return kind === 'tripwire' ? 'line' : 'polygon'
}
