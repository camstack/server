/**
 * Per-device zone-editing state shared between the player overlay
 * (drawing surface) and any sibling that needs to drive it
 * (Detection tab "Add zone" button, player toolbar Zones toggle, …).
 *
 * Implemented as a React context — kept on its own provider so
 * pages that don't render zones don't pay the extra Render. Wrapped
 * by `PlayerOverlaysProvider` in admin-ui's DeviceDetail.
 *
 * Holds two distinct pieces of state:
 *   - `selectedZoneId` — pure selection, fast CRUD path. Operator
 *     clicks a zone on the canvas or in the list, the row + polygon
 *     light up. No mutation flows from selection alone.
 *   - `editingDraft` — non-null while the operator is in unified
 *     edit mode (entered via the pencil button on the Detection tab
 *     row, exited via Save or Discard). All edits — name, colour,
 *     vertex drags — flow into the draft instead of triggering live
 *     `updateZone` RPC calls. The Detection tab commits on Save with
 *     a single round-trip; Discard throws the draft away. Without
 *     this, every keystroke + vertex drop wrote the zones config and
 *     the pipeline runner detached + re-attached the camera per
 *     write — operators saw 8-character zone renames cycle the
 *     pipeline 8 times.
 */
import { useCallback, useContext, useMemo, useState, type ReactNode, type JSX } from 'react'
import { createSharedContext } from '../lib/shared-context'

export type ZoneDrawingKind = 'polygon' | 'tripwire'

export interface ZoneDraftPoint {
  readonly x: number
  readonly y: number
}

export interface ZoneDraft {
  readonly id: string
  readonly kind: ZoneDrawingKind
  readonly name: string
  readonly color: string
  readonly points: ReadonlyArray<ZoneDraftPoint>
}

export interface ZoneEditingState {
  /** Whether the zone editor overlay is active. When `true` the
   *  Konva Stage intercepts clicks; when `false` clicks pass
   *  through to the underlying player. */
  readonly editing: boolean
  /** Active drawing kind. `null` means "select / drag existing
   *  zones". Setting a non-null value triggers a fresh polygon /
   *  tripwire creation on the next click. */
  readonly drawingKind: ZoneDrawingKind | null
  /** Currently-selected zone id (for highlight + ZoneForm). */
  readonly selectedZoneId: string | null
  /** In-flight draft snapshot of the zone being edited. `null` while
   *  no edit session is active — read-only browse mode. */
  readonly editingDraft: ZoneDraft | null
}

export interface ZoneEditingActions {
  setEditing(editing: boolean): void
  setDrawingKind(kind: ZoneDrawingKind | null): void
  setSelectedZoneId(id: string | null): void
  /** Start a new polygon/tripwire — convenience for "Add zone"
   *  buttons that should both unlock the overlay AND select the
   *  shape kind in one click. */
  startDrawing(kind: ZoneDrawingKind): void
  /** Exit edit mode — clears the drawing kind + selection + any
   *  in-flight draft. Called when the Detection tab is torn down. */
  exitEditing(): void
  /** Snapshot a zone into the draft and enter unified edit mode.
   *  If a different draft is already active it is discarded. */
  enterDraft(draft: ZoneDraft): void
  /** Patch the active draft. No-op when no draft is active. */
  updateDraft(patch: Partial<Omit<ZoneDraft, 'id' | 'kind'>>): void
  /** Throw the draft away. Caller is expected to refresh from
   *  upstream zone state (operator chose Discard or navigated away). */
  discardDraft(): void
}

interface ZoneEditingContextValue extends ZoneEditingState, ZoneEditingActions {}

const ZoneEditingContext = createSharedContext<ZoneEditingContextValue | null>(
  'camstack:zone-editing',
  null,
)

export interface ZoneEditingProviderProps {
  readonly children: ReactNode
}

export function ZoneEditingProvider({ children }: ZoneEditingProviderProps): JSX.Element {
  const [editing, setEditingRaw] = useState(false)
  const [drawingKind, setDrawingKindRaw] = useState<ZoneDrawingKind | null>(null)
  const [selectedZoneId, setSelectedZoneIdRaw] = useState<string | null>(null)
  const [editingDraft, setEditingDraftRaw] = useState<ZoneDraft | null>(null)

  const setEditing = useCallback((next: boolean) => {
    setEditingRaw(next)
    if (!next) {
      // Leaving edit mode resets transient sub-states so the next
      // entry starts clean.
      setDrawingKindRaw(null)
      setSelectedZoneIdRaw(null)
      setEditingDraftRaw(null)
    }
  }, [])
  const setDrawingKind = useCallback((kind: ZoneDrawingKind | null) => {
    setDrawingKindRaw(kind)
  }, [])
  const setSelectedZoneId = useCallback((id: string | null) => {
    setSelectedZoneIdRaw(id)
  }, [])
  const startDrawing = useCallback((kind: ZoneDrawingKind) => {
    setEditingRaw(true)
    setSelectedZoneIdRaw(null)
    setDrawingKindRaw(kind)
    setEditingDraftRaw(null)
  }, [])
  const exitEditing = useCallback(() => {
    setEditingRaw(false)
    setDrawingKindRaw(null)
    setSelectedZoneIdRaw(null)
    setEditingDraftRaw(null)
  }, [])
  const enterDraft = useCallback((draft: ZoneDraft) => {
    // Selecting + drafting are coupled — the form/canvas highlight
    // the same zone the operator is editing.
    setSelectedZoneIdRaw(draft.id)
    setEditingDraftRaw(draft)
  }, [])
  const updateDraft = useCallback((patch: Partial<Omit<ZoneDraft, 'id' | 'kind'>>) => {
    setEditingDraftRaw((prev) => (prev === null ? prev : { ...prev, ...patch }))
  }, [])
  const discardDraft = useCallback(() => {
    setEditingDraftRaw(null)
  }, [])

  const value = useMemo<ZoneEditingContextValue>(
    () => ({
      editing,
      drawingKind,
      selectedZoneId,
      editingDraft,
      setEditing,
      setDrawingKind,
      setSelectedZoneId,
      startDrawing,
      exitEditing,
      enterDraft,
      updateDraft,
      discardDraft,
    }),
    [
      editing,
      drawingKind,
      selectedZoneId,
      editingDraft,
      setEditing,
      setDrawingKind,
      setSelectedZoneId,
      startDrawing,
      exitEditing,
      enterDraft,
      updateDraft,
      discardDraft,
    ],
  )

  return <ZoneEditingContext.Provider value={value}>{children}</ZoneEditingContext.Provider>
}

/** Read + drive the zone-editing state. Returns `null` outside a
 *  provider so callers that mount in pages without zones (e.g. a
 *  shared hero on a non-camera device) can no-op gracefully. */
export function useZoneEditing(): ZoneEditingContextValue | null {
  return useContext(ZoneEditingContext)
}
