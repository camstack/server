/**
 * ZoneOverlay — transparent zone editor mounted on top of the device's
 * live frame. Reads its drawing-kind + selection state from
 * `useZoneEditing` (per-device context provided by `ZoneEditingProvider`
 * in `DeviceDetail`). The Detection tab is the only surface that drives
 * it: opening the tab implicitly enables editing, and the tab's
 * `ZoneList` exposes Add polygon / Add tripwire / Cancel inline. There
 * is no in-frame floating toolbar — the player frame stays clear.
 *
 * The drawing surface is the shared `MaskShapeCanvas` (the same Konva
 * plane that backs privacy-mask + motion-zones). Zones are mapped onto
 * `MaskShapeItem`s via `zoneToItem`; a tripwire is a `line` shape, a
 * polygon a `polygon` shape (see `./types`). `MaskShapeCanvas` flips
 * pointer-events dynamically in `transparent` mode — when nothing is
 * selected and no shape is being drawn, clicks pass through to the
 * underlying video.
 *
 * Selection round-trips through context — clicking a zone on the
 * frame highlights its row in the Detection tab list, and vice versa.
 */
import { memo, useCallback, useMemo, useState, Suspense } from 'react'
import type { Zone as CapZone } from '@camstack/types'
import {
  MaskShapeCanvas,
  useDeviceProxy,
  useDeviceStateSlice,
  useZoneEditing,
  useSystem,
} from '@camstack/ui-library'
import type { MaskShape } from '@camstack/types'
import type { MaskShapeItem } from '@camstack/ui-library'
import {
  type Zone as CanvasZone,
  zoneToItem,
  shapeKindToZoneKind,
  newZoneId,
  zoneKindToDrawingKind,
} from './types'

const DEFAULT_COLOR = '#3b82f6'

const SUPPORTED_SHAPES = ['polygon', 'line'] as const

const ZONE_COLOR_PALETTE = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#a855f7',
  '#06b6d4',
  '#f43f5e',
  '#84cc16',
  '#8b5cf6',
  '#14b8a6',
] as const

function pickUnusedZoneColor(existing: readonly { readonly color?: string }[]): string {
  const used = new Set(existing.map((z) => (z.color ?? '').toLowerCase()))
  for (const c of ZONE_COLOR_PALETTE) {
    if (!used.has(c.toLowerCase())) return c
  }
  return ZONE_COLOR_PALETTE[existing.length % ZONE_COLOR_PALETTE.length]!
}

function capToCanvas(z: CapZone): CanvasZone {
  return {
    id: z.id,
    name: z.name,
    kind: z.kind,
    color: z.color || DEFAULT_COLOR,
    points: [...z.polygon],
  }
}

function canvasToCap(z: CanvasZone): CapZone {
  return {
    id: z.id,
    name: z.name,
    kind: z.kind,
    polygon: z.points,
    color: z.color,
  }
}

export interface ZoneOverlayProps {
  readonly deviceId: number
}

function ZoneOverlayImpl({ deviceId }: ZoneOverlayProps) {
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const zonesSlice = useDeviceStateSlice(dev?.state.zones)
  const capZones = useMemo(() => zonesSlice?.zones ?? [], [zonesSlice])

  const editingCtx = useZoneEditing()
  const drawingKind = editingCtx?.drawingKind ?? null
  const selectedZoneId = editingCtx?.selectedZoneId ?? null
  const editingDraft = editingCtx?.editingDraft ?? null

  // Replace the live zone with the in-flight draft for the zone the
  // operator is currently editing. Both name + colour + points come
  // from the draft so vertex drags + form fields agree visually with
  // the polygon on screen.
  const zones = useMemo<CanvasZone[]>(() => {
    return capZones.map((cap) => {
      if (editingDraft && editingDraft.id === cap.id) {
        return {
          id: editingDraft.id,
          name: editingDraft.name,
          kind: editingDraft.kind,
          color: editingDraft.color,
          points: [...editingDraft.points],
        }
      }
      return capToCanvas(cap)
    })
  }, [capZones, editingDraft])

  // Domain zones → shared drawing-plane items. `tripwire` ⇒ `line`,
  // `polygon` ⇒ `polygon` (see `zoneToItem`).
  const items = useMemo<MaskShapeItem[]>(() => zones.map(zoneToItem), [zones])

  const [saveError, setSaveError] = useState<string | null>(null)

  const handleZoneComplete = useCallback(
    async (shape: MaskShape) => {
      // A freshly-drawn shape is always one of the supported point
      // kinds (`MaskShapeCanvas` only emits the kinds in
      // `SUPPORTED_SHAPES`); narrow defensively to drop the
      // never-reached `rect` / `grid` arms.
      if (shape.kind !== 'polygon' && shape.kind !== 'line') return
      const zone: CanvasZone = {
        id: newZoneId(),
        name: '',
        kind: shapeKindToZoneKind(shape.kind),
        color: pickUnusedZoneColor(zones),
        points: [...shape.points],
      }
      setSaveError(null)
      try {
        await system.trpcClient.zones.addZone.mutate({ deviceId, zone: canvasToCap(zone) })
        editingCtx?.setSelectedZoneId(zone.id)
      } catch (err: unknown) {
        console.error('zones.addZone failed', err)
        setSaveError(err instanceof Error ? err.message : String(err))
      }
      editingCtx?.setDrawingKind(null)
    },
    [system, deviceId, zones, editingCtx],
  )

  const handleZonePointsChange = useCallback(
    async (id: string, points: readonly { readonly x: number; readonly y: number }[]) => {
      const next = points.map((p) => ({ x: p.x, y: p.y }))
      // While in unified edit mode, vertex drags update the draft
      // (in-memory only) instead of round-tripping to the backend.
      // The Detection tab's Save button commits the draft once.
      if (editingDraft && editingDraft.id === id) {
        editingCtx?.updateDraft({ points: next })
        return
      }
      const existing = zones.find((z) => z.id === id)
      if (!existing) return
      try {
        await system.trpcClient.zones.updateZone.mutate({
          deviceId,
          zone: canvasToCap({ ...existing, points: next }),
        })
      } catch (err: unknown) {
        console.error('zones.updateZone failed', err)
        setSaveError(err instanceof Error ? err.message : String(err))
      }
    },
    [system, deviceId, zones, editingDraft, editingCtx],
  )

  // Every edit from the shared canvas arrives as `onShapeChange(id,
  // shape)`. Only the point kinds (`polygon` / `line`) are reachable
  // for zones; extract the new point set and route it through the
  // existing draft-vs-live update path.
  const handleShapeChange = useCallback(
    (id: string | number, shape: MaskShape): void => {
      if (typeof id !== 'string') return
      if (shape.kind !== 'polygon' && shape.kind !== 'line') return
      void handleZonePointsChange(id, shape.points)
    },
    [handleZonePointsChange],
  )

  // Stable callback fed to <MaskShapeCanvas/> — referential equality
  // lets `React.memo(MaskShapeCanvas)` bail out cleanly while detection
  // events fire upstream (otherwise every re-render of this component
  // would invalidate the memo).
  //
  // Selection IS edit-mode: clicking a zone on the canvas enters
  // draft state immediately (mirrors the `ZoneList` row-click flow in
  // the Detection tab). Deselecting (`null`) discards the draft.
  const handleSelect = useCallback(
    (id: string | number | null): void => {
      if (id === null) {
        editingCtx?.discardDraft()
        editingCtx?.setSelectedZoneId(null)
        return
      }
      if (typeof id !== 'string') return
      const z = zones.find((cur) => cur.id === id)
      if (!z) {
        editingCtx?.setSelectedZoneId(id)
        return
      }
      editingCtx?.enterDraft({
        id: z.id,
        kind: z.kind,
        name: z.name,
        color: z.color,
        points: z.points,
      })
    },
    [zones, editingCtx],
  )

  // Render only when there's something to show — existing zones to
  // edit, or an active draw started from the Detection tab. With no
  // zones AND no draw in progress, the player frame stays untouched.
  if (zones.length === 0 && drawingKind === null && saveError === null) return null

  // MaskShapeCanvas is exported as a React.lazy component from
  // @camstack/ui-library (keeps ~300 KB konva bundle off first paint).
  // Wrap in <Suspense> so the lazy boundary is handled here.
  return (
    <Suspense fallback={null}>
      <MaskShapeCanvas
        transparent
        items={items}
        supportedShapes={SUPPORTED_SHAPES}
        selectedId={selectedZoneId}
        onSelect={handleSelect}
        onShapeChange={handleShapeChange}
        onDrawComplete={(shape) => {
          void handleZoneComplete(shape)
        }}
        drawingKind={drawingKind === null ? null : zoneKindToDrawingKind(drawingKind)}
      />
      {saveError !== null && (
        <p
          role="alert"
          className="absolute inset-x-2 bottom-2 rounded-md border border-danger/40 bg-background-elevated px-2 py-1 text-xs text-danger"
        >
          {saveError}
        </p>
      )}
    </Suspense>
  )
}

/**
 * Memoised export — `<ZoneOverlay deviceId={n}/>` lives in the
 * player-overlay registry and is rendered inside `StreamPanel`'s
 * `extraOverlay` slot. Detection events (motion / bbox / phase) fire
 * 5–30Hz and would otherwise propagate down through `StreamPanel`
 * into this subtree on every event, re-evaluating the entire Konva
 * scene. Memoising on `deviceId` (the only prop) lets React skip
 * those renders entirely; the overlay still updates whenever its
 * own state hooks fire (`useDeviceStateSlice(zones)` /
 * `useZoneEditing`), which is the actual rate of change for the
 * editor surface.
 */
export const ZoneOverlay = memo(ZoneOverlayImpl)
