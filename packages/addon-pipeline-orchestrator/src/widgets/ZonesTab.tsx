/**
 * Detection tab — zone list / form / per-stage rule editors.
 *
 * The polygon canvas is drawn over the device-detail live frame via
 * `ZoneOverlay`; this tab is the management surface that pairs with
 * it. The tab does three things on mount:
 *
 *   1. Registers the `ZoneOverlay` layer with the player-overlays
 *      registry (`usePlayerOverlayLayer`) so the live frame paints
 *      zones whenever this tab is open. Tearing down the tab removes
 *      the layer automatically.
 *   2. Registers a "Zones" toolbar button on the player toolbar
 *      (`usePlayerToolbarButton`) so the operator can flip edit mode
 *      from the player without leaving the tab.
 *   3. Reads + writes per-device zone-editing state via
 *      `useZoneEditing` — the in-tab list and inline form share
 *      `selectedZoneId` with the overlay, so clicking a zone on
 *      the live frame highlights its row here, and vice versa.
 *
 * The tab keeps the per-stage rule editors below the zone list since
 * those still need vertical space (tables of motion / detection rules
 * per zone × per class).
 */
import { useCallback, useMemo, useState } from 'react'
import type { Zone as CapZone, DeviceProxy } from '@camstack/types'
import {
  useDeviceProxy,
  useDeviceStateSlice,
  usePlayerOverlayLayer,
  useZoneEditing,
  useSystem,
  SECTION_CARD,
  SECTION_HEADER,
  SECTION_BODY,
  STACK_GAP,
  GRID_GAP,
  TEXT_SECTION_LABEL,
  TEXT_HINT,
} from '@camstack/ui-library'
import { Trans, useT } from '../i18n/index.js'
import { ZoneList } from './zone-editor/ZoneList'
import { ZoneForm } from './zone-editor/ZoneForm'
import { ZoneRulesEditor } from './zone-editor/ZoneRulesEditor'
import { ZoneOverlay } from './zone-editor/ZoneOverlay'
import type { Zone as CanvasZone, ZoneKind as CanvasZoneKind } from './zone-editor/types'

const DEFAULT_COLOR = '#3b82f6'

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

export interface ZonesTabProps {
  readonly deviceId: number
}

export function ZonesTab({ deviceId }: ZonesTabProps) {
  const { t } = useT()
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const zonesSlice = useDeviceStateSlice(dev?.state.zones)
  const capZones = useMemo(() => zonesSlice?.zones ?? [], [zonesSlice])
  const zones = useMemo(() => capZones.map(capToCanvas), [capZones])

  const [actionError, setActionError] = useState<string | null>(null)
  const editingCtx = useZoneEditing()
  const drawingKind = editingCtx?.drawingKind ?? null
  const selectedZoneId = editingCtx?.selectedZoneId ?? null
  const editingDraft = editingCtx?.editingDraft ?? null

  // ── Player-overlays registry ────────────────────────────────────
  // The layer is registered for the lifetime of the tab — opening
  // the Detection tab IS edit mode, so there's no separate toolbar
  // toggle to flip it on. The spec is memoised so the registry
  // doesn't churn on every parent render (the registration effect
  // depends on referential equality of the spec object — see
  // `usePlayerOverlayLayer` JSDoc).
  const overlaySpec = useMemo(
    () => ({
      id: 'zones',
      order: 100, // above PTZ overlay (order 0) so handles aren't occluded
      node: <ZoneOverlay deviceId={deviceId} />,
    }),
    [deviceId],
  )
  usePlayerOverlayLayer(overlaySpec)

  // ── Zone CRUD ──────────────────────────────────────────────────
  // Selection IS edit-mode: clicking a zone (canvas or list row)
  // immediately enters draft mode for that zone. Deselecting (`null`)
  // discards any in-flight draft. There's no separate "select" → "edit"
  // step — operators reported the intermediate browse-only state was
  // confusing ("è come ci fossero 3 modalità").
  const handleSelectZone = useCallback(
    (id: string | null): void => {
      if (id === null) {
        editingCtx?.discardDraft()
        editingCtx?.setSelectedZoneId(null)
        return
      }
      const z = zones.find((cur) => cur.id === id)
      if (!z) return
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

  const handleSaveDraft = useCallback(async () => {
    const draft = editingCtx?.editingDraft
    if (!draft) return
    try {
      await system.trpcClient.zones.updateZone.mutate({
        deviceId,
        zone: canvasToCap({
          id: draft.id,
          kind: draft.kind,
          name: draft.name,
          color: draft.color,
          points: [...draft.points],
        }),
      })
    } catch (err: unknown) {
      console.error('zones.updateZone failed', err)
      setActionError(err instanceof Error ? err.message : String(err))
    }
    // Save + Discard both clear the selection so the form doesn't
    // linger in a read-only "third" state. Two modes only: not
    // selected (no form) → selected (editable form).
    editingCtx?.discardDraft()
    editingCtx?.setSelectedZoneId(null)
  }, [system, deviceId, editingCtx])

  const handleDiscardDraft = useCallback(() => {
    editingCtx?.discardDraft()
    editingCtx?.setSelectedZoneId(null)
  }, [editingCtx])

  const handleDeleteZone = useCallback(
    async (id: string) => {
      try {
        await system.trpcClient.zones.removeZone.mutate({ deviceId, zoneId: id })
      } catch (err: unknown) {
        console.error('zones.removeZone failed', err)
        setActionError(err instanceof Error ? err.message : String(err))
      }
      if (editingCtx?.selectedZoneId === id) editingCtx.setSelectedZoneId(null)
      if (editingCtx?.editingDraft?.id === id) editingCtx.discardDraft()
    },
    [system, deviceId, editingCtx],
  )

  // List-side "Add polygon / Add tripwire" buttons drive the same
  // overlay state: switch the overlay into edit-mode + arm the
  // chosen drawing kind. The next click on the live frame creates
  // the shape via `ZoneOverlay → handleZoneComplete`.
  const handleStartDraw = useCallback(
    (kind: CanvasZoneKind) => {
      editingCtx?.startDrawing(kind)
    },
    [editingCtx],
  )
  const handleCancelDraw = useCallback(() => {
    editingCtx?.setDrawingKind(null)
  }, [editingCtx])

  // The form is bound strictly to the in-flight draft — selection
  // alone (without a draft) does not render it. This enforces the
  // 2-mode contract: either no zone is being edited (form hidden),
  // or one zone is being edited (form visible + interactive).
  const selectedZone: CanvasZone | null = useMemo(() => {
    if (!editingDraft) return null
    const base = zones.find((z) => z.id === editingDraft.id)
    if (!base) return null
    return {
      id: editingDraft.id,
      kind: editingDraft.kind,
      name: editingDraft.name,
      color: editingDraft.color,
      points: [...editingDraft.points],
    }
  }, [zones, editingDraft])

  return (
    <div className={STACK_GAP}>
      <div className={SECTION_CARD}>
        <div className={SECTION_HEADER}>
          <div className="min-w-0">
            <h2 className={TEXT_SECTION_LABEL}>{t('zonesTab.title')}</h2>
            <p className={`${TEXT_HINT} mt-0.5 leading-tight`}>
              <Trans
                i18nKey="zonesTab.hint"
                components={{ b: <strong className="text-foreground" /> }}
              />
            </p>
          </div>
        </div>

        <div className={`${SECTION_BODY} flex flex-col gap-3`}>
          <ZoneList
            zones={zones}
            selectedZoneId={selectedZoneId}
            drawingKind={drawingKind}
            onSelectZone={handleSelectZone}
            onDeleteZone={handleDeleteZone}
            onStartDraw={handleStartDraw}
            onCancelDraw={handleCancelDraw}
          />

          {actionError !== null && (
            <p role="alert" className="text-xs text-danger">
              {actionError}
            </p>
          )}

          {selectedZone && (
            <>
              <div className="border-t border-border" />
              <ZoneForm
                zone={selectedZone}
                onSave={handleSaveDraft}
                onDiscard={handleDiscardDraft}
                onDelete={() => handleDeleteZone(selectedZone.id)}
              />
            </>
          )}
        </div>
      </div>

      {/* Motion + Detection + Package rules — each editor packs a header
          bar (Add / Save) plus per-zone × per-class rule rows, so the
          column gets cramped well before the shared `GRID_PAIRED`
          (lg:grid-cols-2 → 1024px) breakpoint kicks in. We stay
          single-column until well beyond that and only pair them on
          extra-wide displays.

          The `package` stage backs the package-drop detector: a package
          rule references drawn polygon(s) (drawn in the shared canvas
          above) that bound the delivery/pick-up area. The detector fires
          only on stationary package-class objects inside these zones —
          see docs/superpowers/specs/2026-07-17-package-zones-design.md. */}
      <div className={`grid grid-cols-1 2xl:grid-cols-2 ${GRID_GAP}`}>
        <ZoneRulesEditor dev={dev} deviceId={deviceId} stage="motion" zones={capZones} />
        <ZoneRulesEditor dev={dev} deviceId={deviceId} stage="detection" zones={capZones} />
        <ZoneRulesEditor dev={dev} deviceId={deviceId} stage="package" zones={capZones} />
      </div>
    </div>
  )
}

export type { DeviceProxy as ZonesTabDeviceProxy }
