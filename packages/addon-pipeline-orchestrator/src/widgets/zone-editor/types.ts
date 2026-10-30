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

/**
 * A fresh zone id. `crypto.randomUUID` exists only in secure contexts, and a
 * hub reached over plain http on the LAN is not one, so it falls back to
 * `getRandomValues` (available everywhere) formatted as a v4 UUID.
 */
export function newZoneId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
