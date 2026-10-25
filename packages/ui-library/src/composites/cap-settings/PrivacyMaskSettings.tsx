/**
 * PrivacyMaskSettings — management surface for the on-camera
 * `privacy-mask` capability.
 *
 * The cap was reshaped from a boolean cell-grid into a SHAPE model: up to
 * `maxRegions` zones, each a rectangle or a free polygon (normalized 0..1
 * of the camera frame). This component owns the draft zone list and edits
 * it via the shared `MaskShapeCanvas` drawing-plane, painted over the live
 * frame only while editing.
 *
 * Structure:
 *   - The editable SHAPES are painted over the live frame by the shared
 *     `MaskShapeCanvas`, registered as a player-overlay layer ONLY while
 *     "Edit mask" is toggled on (OFF by default — nothing draws on mount).
 *   - Every CONTROL lives in the panel: edit-mode toggle, master enable,
 *     Add rect / Add polygon (gated by `supportedShapes` + `maxRegions`,
 *     they arm the canvas' draw mode), active-count display, Revert, Save.
 *
 * Registered as host widget `host/privacy-mask-grid` (see
 * `widgets/host-widgets.ts`) so the D14 device-config cap framework mounts
 * it on the Image tab. Self-gates with `isAbsentProvider` to a friendly
 * "not supported" message when the camera has no privacy-mask cap.
 *
 * **It owns BOTH privacy planes.** The cap covers what the camera does not
 * film and what it does not hear, so the microphone control lives here too
 * ([D113](../../../../../docs/decisions/adr-0113.md) phase 3, the
 * `device-audio` row — this panel is the only writer of
 * `privacyMask.setAudioEnabled` outside the deprecated switch shim). It is
 * deliberately NOT part of the mask draft: its own mutation, written
 * immediately and read back, so Save-ing the zones never rewrites the
 * microphone, and it renders even on a camera with zero mask slots.
 */

import type {
  MaskShape,
  MaskShapeKind,
  PrivacyMaskOptions,
  PrivacyMaskRegion,
} from '@camstack/types'
import { EyeOff, Hexagon, Mic, MicOff, Square, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { usePlayerOverlayLayer } from '../../contexts/player-overlays'
import { useSystem } from '../../contexts/system-context'
import { UiTrans, useUiText } from '../../contexts/ui-text'
import { useDeviceProxy } from '../../hooks/use-device-proxy'
import { isAbsentProvider } from '../../lib/cap-error'
import { TEXT_HINT } from '../../lib/responsive'
import { WidgetPanel } from '../widget-panel'
import type { CapSettingsComponentProps } from './index'
import { MaskShapeCanvas, type MaskShapeItem } from './MaskShapeCanvas'
import { cameraMicrophoneWrite, resolveCameraMicrophone } from './privacy-mask-audio'

// A privacy-mask region's geometry is the rect|polygon subset of the shared
// MaskShape vocabulary. Narrowing the full union back to this subset on a
// canvas edit keeps the draft strictly typed without a cast.
type PrivacyMaskShapeKind = PrivacyMaskRegion['shape']['kind']
type PrivacyMaskShape = PrivacyMaskRegion['shape']

// Privacy-mask overlay sits above the motion-zones overlay (order 110).
const PRIVACY_MASK_OVERLAY_ORDER = 120
const OVERLAY_ID = 'privacy-mask'

const BTN_NEUTRAL =
  'rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-medium text-foreground-subtle hover:bg-surface-hover disabled:opacity-40 transition-colors'
const BTN_PRIMARY =
  'rounded-md border border-primary/50 bg-primary/15 px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/25 disabled:opacity-40 transition-colors'

/** Narrow the full MaskShape union to a privacy-mask shape (rect|polygon). */
function toPrivacyMaskShape(shape: MaskShape): PrivacyMaskShape | null {
  if (shape.kind === 'rect' || shape.kind === 'polygon') return shape
  return null
}

/** Next free 0-based integer id not already used by a draft region. */
function nextRegionId(regions: readonly PrivacyMaskRegion[]): number {
  const used = new Set(regions.map((r) => r.id))
  let id = 0
  while (used.has(id)) id += 1
  return id
}

/** Structural equality for a draft vs. committed region list (order-sensitive). */
function regionsEqual(a: readonly PrivacyMaskRegion[], b: readonly PrivacyMaskRegion[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false
  }
  return true
}

interface PrivacyMaskDraft {
  readonly enabled: boolean
  readonly regions: readonly PrivacyMaskRegion[]
}

export function PrivacyMaskSettings({ deviceId }: CapSettingsComponentProps): JSX.Element | null {
  const t = useUiText()
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)

  const [options, setOptions] = useState<PrivacyMaskOptions | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  /**
   * The camera answered with `regions: null` — it has NOT been reached, so
   * what it holds is unknown. The editor refuses to open on that: seeding an
   * empty canvas from an unanswered read puts the operator one Save away from
   * deleting zones nobody could see (the save writes the draft verbatim, and
   * on Hikvision it DELETEs every slot first). Distinct from `unsupported`,
   * which is a real answer about the camera's abilities.
   */
  const [unreadable, setUnreadable] = useState(false)
  const [draft, setDraft] = useState<PrivacyMaskDraft | null>(null)
  const [committed, setCommitted] = useState<PrivacyMaskDraft | null>(null)
  const [saving, setSaving] = useState(false)
  // Explicit edit mode — the editable shapes paint over the live frame ONLY
  // while toggled on. Default OFF: nothing draws on mount.
  const [editing, setEditing] = useState(false)
  // Which zone the drawing-plane has selected (drives its editing chrome).
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // When set, the canvas drops the next click as a new shape of that kind.
  const [drawingKind, setDrawingKind] = useState<MaskShapeKind | null>(null)
  // ── The AUDIO plane (D113 phase 3, `device-audio`) ──────────────────────
  // Held apart from the mask draft on purpose: `setAudioEnabled` is its own
  // mutation and is written immediately, so Save-ing the ZONES never rewrites
  // the microphone. `null` = the camera did not answer, which is UNKNOWN and
  // never "the microphone is off".
  const [audioEnabled, setAudioEnabled] = useState<boolean | null>(null)
  const [pendingAudio, setPendingAudio] = useState<boolean | null>(null)
  const [audioFailure, setAudioFailure] = useState<string | null>(null)

  // Load availability + seed the draft from a fresh getStatus(). A
  // getOptions failure self-gates the editor (camera has no cap).
  const seededRef = useRef(false)
  useEffect(() => {
    if (!dev) return undefined
    let cancelled = false
    seededRef.current = false
    setOptions(null)
    setUnsupported(false)
    setUnreadable(false)
    setDraft(null)
    setCommitted(null)
    setEditing(false)
    setSelectedId(null)
    setDrawingKind(null)
    setAudioEnabled(null)
    setPendingAudio(null)
    setAudioFailure(null)
    void (async () => {
      try {
        const opts = await dev.privacyMask?.getOptions({})
        if (cancelled) return
        if (!opts) throw new Error('device proxy not ready')
        setOptions(opts)
        if (seededRef.current) return
        const status = await dev.privacyMask?.getStatus({})
        if (cancelled) return
        if (!status) throw new Error('device proxy not ready')
        // `regions: null` is "we have not reached this camera", not "no
        // zones". Opening the editor on it would draw an empty canvas over a
        // mask that may well exist, and Save writes the canvas verbatim.
        if (status.regions === null) {
          setUnreadable(true)
          setAudioEnabled(status.audioEnabled)
          return
        }
        seededRef.current = true
        const seed: PrivacyMaskDraft = { enabled: status.enabled, regions: status.regions }
        setCommitted(seed)
        setDraft(seed)
        // Same answer, second plane — no extra round trip. A camera muted
        // through the deprecated switch group (which wrote this same cap, on
        // this same device) therefore reads OFF on the first render.
        setAudioEnabled(status.audioEnabled)
      } catch (err: unknown) {
        if (cancelled) return
        if (isAbsentProvider(err)) setUnsupported(true)
        // eslint-disable-next-line no-console -- error-path diagnostic; UI code has no scoped logger
        else console.error('Privacy Mask load failed', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dev])

  const dirty = useMemo(
    () =>
      draft !== null &&
      committed !== null &&
      (draft.enabled !== committed.enabled || !regionsEqual(draft.regions, committed.regions)),
    [draft, committed],
  )
  const activeCount = draft ? draft.regions.length : 0
  const maxRegions = options ? options.maxRegions : 0
  // A drawn shape MUST always land in the draft. `onDrawComplete` ran inside a
  // useCallback closure over `maxRegions`; while options were still loading (or
  // when a stale closure captured `0`) the `>= maxRegions` guard blocked EVERY
  // add — the shape was silently dropped, the draft stayed empty, and Save sent
  // `[]` ("not persisted"). The live limit is mirrored here so the add-handler
  // never reads a stale `0`, and a non-positive limit is treated as UNKNOWN (do
  // not block) rather than zero-capacity. The button still uses the rendered
  // `atCapacity` for affordance.
  const maxRegionsRef = useRef(0)
  useEffect(() => {
    maxRegionsRef.current = maxRegions
  }, [maxRegions])
  const atCapacity = maxRegions > 0 && activeCount >= maxRegions

  const toggleEnabled = useCallback((): void => {
    setDraft((prev) => (prev ? { ...prev, enabled: !prev.enabled } : prev))
  }, [])

  // The canvas reports the selected id from the full string|number|null
  // domain; every privacy-mask item id is a numeric region id, so narrow to
  // the number|null the local selection state holds (no cast).
  const onSelect = useCallback((id: string | number | null): void => {
    setSelectedId(typeof id === 'number' ? id : null)
  }, [])

  // ── Canvas ↔ draft mapping ───────────────────────────────────────────────
  // Each region maps to one drawing-plane item. The full-union shape is safe
  // here: a privacy-mask shape (rect|polygon) is a MaskShape.
  const items = useMemo<MaskShapeItem[]>(
    () =>
      draft
        ? draft.regions.map((r) => ({
            id: r.id,
            shape: r.shape,
            enabled: r.enabled,
            label: t('uiLibrary.privacyMaskSettings.zoneN', 'Zone {{id}}', { id: r.id }),
          }))
        : [],
    [draft, t],
  )

  // Controlled edit of an existing region's geometry.
  const onShapeChange = useCallback((id: string | number, shape: MaskShape): void => {
    const next = toPrivacyMaskShape(shape)
    if (!next) return
    setDraft((prev) =>
      prev
        ? { ...prev, regions: prev.regions.map((r) => (r.id === id ? { ...r, shape: next } : r)) }
        : prev,
    )
  }, [])

  // A freshly-drawn shape becomes a new region. After a draw lands, disarm
  // draw-mode and select the new zone for tweaking. The capacity gate reads the
  // LIVE limit from a ref (never a stale closure) and only blocks when the limit
  // is a known positive number — an unknown/zero limit must NOT silently drop
  // the shape (that was the "not persisted" bug). Empty deps keep the handler
  // identity stable so an in-flight draw can't capture an obsolete closure.
  const onDrawComplete = useCallback((shape: MaskShape): void => {
    const next = toPrivacyMaskShape(shape)
    if (!next) return
    setDrawingKind(null)
    setDraft((prev) => {
      if (!prev) return prev
      const limit = maxRegionsRef.current
      if (limit > 0 && prev.regions.length >= limit) return prev
      const id = nextRegionId(prev.regions)
      const region: PrivacyMaskRegion = { id, enabled: true, shape: next }
      setSelectedId(id)
      return { ...prev, regions: [...prev.regions, region] }
    })
  }, [])

  // Arm the canvas to draw a new shape of `kind`. Adding a zone is only
  // meaningful while the operator can see/place it, so force edit mode on.
  const armDraw = useCallback((kind: PrivacyMaskShapeKind): void => {
    setEditing(true)
    setSelectedId(null)
    setDrawingKind(kind)
  }, [])

  // Select a zone for editing from the panel list — selection IS edit mode
  // (mirrors the orchestrator zones drawer). Force editing on so the canvas
  // mounts and disarm any pending draw.
  const selectRegion = useCallback((id: number): void => {
    setEditing(true)
    setDrawingKind(null)
    setSelectedId(id)
  }, [])

  // Remove a zone from the draft (Save persists the deletion). Clear the
  // selection if it pointed at the removed zone. Delete lives in the panel,
  // never on the canvas (per the orchestrator zones-drawer convention).
  const deleteRegion = useCallback((id: number): void => {
    setSelectedId((cur) => (cur === id ? null : cur))
    setDraft((prev) =>
      prev ? { ...prev, regions: prev.regions.filter((r) => r.id !== id) } : prev,
    )
  }, [])

  const revert = useCallback((): void => {
    setDrawingKind(null)
    setSelectedId(null)
    if (committed) setDraft({ enabled: committed.enabled, regions: committed.regions })
  }, [committed])

  const save = useCallback(async (): Promise<void> => {
    if (!dev || !draft) return
    setSaving(true)
    try {
      await dev.privacyMask?.setMask({
        patch: { enabled: draft.enabled, regions: [...draft.regions] },
      })
      const fresh = await dev.privacyMask?.getStatus({})
      // A read-back that did not answer (`regions: null`) leaves the draft
      // exactly as the operator saved it. Replacing it with an empty canvas
      // would make a successful write look like it wrote nothing.
      if (fresh && fresh.regions !== null) {
        const norm: PrivacyMaskDraft = { enabled: fresh.enabled, regions: fresh.regions }
        setCommitted(norm)
        setDraft(norm)
      }
    } catch (err: unknown) {
      // eslint-disable-next-line no-console -- error-path diagnostic; UI code has no scoped logger
      console.error('Privacy Mask save failed', err)
    } finally {
      setSaving(false)
    }
  }, [dev, draft])

  // ── The microphone (D113 `device-audio`) ─────────────────────────────────
  // Derived from the SAME `getOptions` + `getStatus` pair the mask uses, so the
  // two planes cannot report from different moments.
  const microphone = resolveCameraMicrophone({
    supportsAudioMute: options === null ? null : options.supportsAudioMute,
    audioEnabled,
    pendingOn: pendingAudio,
  })

  const toggleMicrophone = useCallback(async (): Promise<void> => {
    const write = cameraMicrophoneWrite(microphone)
    if (!dev || write === null) return
    setPendingAudio(write.enabled)
    setAudioFailure(null)
    try {
      await dev.privacyMask?.setAudioEnabled(write)
      // Read the CAMERA back rather than trusting the write. This cap has no
      // server-side mirror by design, so the device is the only thing that can
      // say what the microphone is now doing.
      const fresh = await dev.privacyMask?.getStatus({})
      if (fresh) setAudioEnabled(fresh.audioEnabled)
    } catch (err: unknown) {
      // A revert nobody announces reads as a write that worked.
      // eslint-disable-next-line no-console -- error-path diagnostic; UI code has no scoped logger
      console.error('Privacy microphone write failed — reverting', err)
      setAudioFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setPendingAudio(null)
    }
  }, [dev, microphone])

  // Leaving edit mode disarms any pending draw + selection so no chrome
  // lingers on the live frame.
  const toggleEditing = useCallback((): void => {
    setEditing((v) => {
      if (v) {
        setDrawingKind(null)
        setSelectedId(null)
      }
      return !v
    })
  }, [])

  const supportedShapes = options?.supportedShapes ?? []

  // Register the shapes overlay ONLY while editing — default OFF, nothing
  // paints over the live stream on mount. `null` also covers the
  // pre-load / unsupported states; the hook stays unconditional for a
  // stable hook order.
  const overlaySpec = useMemo(
    () =>
      editing && !unsupported && options && draft
        ? {
            id: OVERLAY_ID,
            order: PRIVACY_MASK_OVERLAY_ORDER,
            node: (
              <MaskShapeCanvas
                transparent
                items={items}
                supportedShapes={supportedShapes}
                polygonVertices={options.polygonVertices}
                selectedId={selectedId}
                onSelect={onSelect}
                onShapeChange={onShapeChange}
                onDrawComplete={onDrawComplete}
                drawingKind={drawingKind}
              />
            ),
          }
        : null,
    [
      editing,
      unsupported,
      options,
      draft,
      items,
      supportedShapes,
      selectedId,
      onSelect,
      onShapeChange,
      onDrawComplete,
      drawingKind,
    ],
  )
  usePlayerOverlayLayer(overlaySpec)

  const supportsRect = options?.supportedShapes.includes('rect') ?? false
  const supportsPolygon = options?.supportedShapes.includes('polygon') ?? false
  // The camera advertised the cap but reports zero usable slots/shapes (e.g.
  // some Reolink models return maxNum=0) — it can't store a privacy mask, so
  // treat it as unsupported instead of showing a dead editor.
  const noShapes =
    options !== null && (options.maxRegions <= 0 || options.supportedShapes.length === 0)
  const ready = !unsupported && !noShapes && !unreadable && options !== null && draft !== null

  // Wait for the device proxy before mounting — avoids a transient
  // "not ready" console error (mirrors MotionZonesSettings).
  if (!dev) return null

  return (
    <WidgetPanel
      title={t('uiLibrary.privacyMaskSettings.title', 'Privacy Mask')}
      icon={<EyeOff className="h-3.5 w-3.5 text-foreground-subtle" />}
    >
      <div className="flex flex-col gap-3">
        {unsupported || noShapes ? (
          <p className={`${TEXT_HINT} leading-relaxed`}>
            {t(
              'uiLibrary.privacyMaskSettings.unsupported',
              "This camera doesn't support an on-board privacy mask.",
            )}
          </p>
        ) : unreadable ? (
          <p className={`${TEXT_HINT} leading-relaxed`}>
            {t(
              'uiLibrary.privacyMaskSettings.unreadable',
              "This camera hasn't answered, so what it currently masks is unknown — the editor stays closed rather than showing an empty frame you could save over. A battery camera answers once it wakes; otherwise check that it is reachable.",
            )}
          </p>
        ) : !ready ? (
          <p className={`${TEXT_HINT} leading-relaxed`}>
            {t('uiLibrary.privacyMaskSettings.loading', "Loading the camera's privacy mask…")}
          </p>
        ) : (
          <>
            <p className={`${TEXT_HINT} leading-relaxed`}>
              <UiTrans
                uiKey="uiLibrary.privacyMaskSettings.help"
                fallback="Toggle <0>Edit mask</0> to draw blanked-out zones on the live frame, then <1>Save</1> to push them to the camera. Drag a rectangle to move, its corner to resize; drag polygon vertices, click an edge midpoint to add one, or right-click a vertex to remove it."
                components={[
                  <strong key="edit" className="text-foreground" />,
                  <strong key="save" className="text-foreground" />,
                ]}
              />
            </p>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={toggleEditing}
                disabled={saving}
                aria-pressed={editing}
                className={editing ? BTN_PRIMARY : BTN_NEUTRAL}
              >
                {editing
                  ? t('uiLibrary.privacyMaskSettings.doneEditing', 'Done editing')
                  : t('uiLibrary.privacyMaskSettings.editMask', 'Edit mask')}
              </button>
              <button
                type="button"
                onClick={toggleEnabled}
                disabled={saving}
                aria-pressed={draft.enabled}
                className={draft.enabled ? BTN_PRIMARY : BTN_NEUTRAL}
              >
                {draft.enabled
                  ? t('uiLibrary.privacyMaskSettings.maskOn', 'Mask on')
                  : t('uiLibrary.privacyMaskSettings.maskOff', 'Mask off')}
              </button>

              {supportsRect && (
                <button
                  type="button"
                  onClick={() => armDraw('rect')}
                  disabled={saving || atCapacity}
                  aria-pressed={drawingKind === 'rect'}
                  className={drawingKind === 'rect' ? BTN_PRIMARY : BTN_NEUTRAL}
                  title={
                    atCapacity
                      ? t('uiLibrary.privacyMaskSettings.maxZones', 'Maximum zones reached')
                      : t('uiLibrary.privacyMaskSettings.addRect', 'Add a rectangle zone')
                  }
                >
                  {t('uiLibrary.privacyMaskSettings.rectButton', '+ Rect')}
                </button>
              )}
              {supportsPolygon && (
                <button
                  type="button"
                  onClick={() => armDraw('polygon')}
                  disabled={saving || atCapacity}
                  aria-pressed={drawingKind === 'polygon'}
                  className={drawingKind === 'polygon' ? BTN_PRIMARY : BTN_NEUTRAL}
                  title={
                    atCapacity
                      ? t('uiLibrary.privacyMaskSettings.maxZones', 'Maximum zones reached')
                      : t('uiLibrary.privacyMaskSettings.addPolygon', 'Add a polygon zone')
                  }
                >
                  {t('uiLibrary.privacyMaskSettings.polygonButton', '+ Polygon')}
                </button>
              )}

              <span className={`${TEXT_HINT} ml-1 tabular-nums`}>
                {t('uiLibrary.privacyMaskSettings.zoneCount', '{{active}} / {{max}} zones', {
                  active: activeCount,
                  max: maxRegions,
                })}
              </span>

              <span className="flex-1" />

              <button
                type="button"
                onClick={revert}
                disabled={saving || !dirty}
                className="rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-foreground-subtle hover:bg-surface-hover disabled:opacity-40 transition-colors"
              >
                {t('uiLibrary.privacyMaskSettings.revert', 'Revert')}
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !dirty}
                className={BTN_PRIMARY}
              >
                {saving
                  ? t('uiLibrary.privacyMaskSettings.saving', 'Saving…')
                  : t('uiLibrary.privacyMaskSettings.save', 'Save')}
              </button>
            </div>

            {/* Zone list — select to edit (mirrors the orchestrator zones
                drawer), delete here in the panel (never on the canvas). */}
            {activeCount > 0 ? (
              <div className="flex flex-col gap-1">
                {draft.regions.map((r) => {
                  const selected = selectedId === r.id
                  const ShapeIcon = r.shape.kind === 'polygon' ? Hexagon : Square
                  return (
                    <div
                      key={r.id}
                      className={`flex items-center gap-2 rounded-md border px-2 py-1 transition-colors ${
                        selected ? 'border-primary/50 bg-primary/10' : 'border-border bg-surface'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => selectRegion(r.id)}
                        disabled={saving}
                        className="flex flex-1 items-center gap-2 text-left text-[11px] font-medium text-foreground-subtle hover:text-foreground disabled:opacity-40 transition-colors"
                      >
                        <ShapeIcon className="h-3.5 w-3.5 shrink-0" />
                        <span>
                          {t('uiLibrary.privacyMaskSettings.zoneN', 'Zone {{id}}', { id: r.id })}
                        </span>
                        <span className="text-foreground-faint capitalize">{r.shape.kind}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteRegion(r.id)}
                        disabled={saving}
                        aria-label={t(
                          'uiLibrary.privacyMaskSettings.deleteZoneN',
                          'Delete zone {{id}}',
                          {
                            id: r.id,
                          },
                        )}
                        title={t('uiLibrary.privacyMaskSettings.deleteZone', 'Delete zone')}
                        className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface text-foreground-subtle hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40 transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </>
        )}

        {/* ── The audio plane — the camera's own microphone (D113 phase 3).
            Rendered independently of the mask: a camera can advertise a
            writable microphone and hold zero mask zones, and hiding the
            microphone behind "no on-board privacy mask" would leave that
            camera with no way to go silent at all. Only drawn when the camera
            says it can be written — a control that changes nothing is worse
            than no control. ── */}
        {microphone.supported && (
          <div className="flex items-start gap-3 rounded-md border border-border bg-surface px-2 py-2">
            <button
              type="button"
              role="switch"
              aria-label={microphone.label}
              aria-checked={microphone.on === true}
              disabled={!microphone.available || pendingAudio !== null}
              onClick={() => void toggleMicrophone()}
              title={
                microphone.on === null
                  ? t(
                      'uiLibrary.privacyMaskSettings.micTitleUnknown',
                      'Microphone — state unknown; the camera did not answer.',
                    )
                  : microphone.on
                    ? t(
                        'uiLibrary.privacyMaskSettings.micTitleOn',
                        'The camera is capturing sound. Turning it off: {{cost}}',
                        { cost: microphone.costWhenOff },
                      )
                    : t(
                        'uiLibrary.privacyMaskSettings.micTitleOff',
                        'The camera is silent. {{cost}}',
                        { cost: microphone.costWhenOff },
                      )
              }
              className={
                microphone.on === false || microphone.on === null ? BTN_NEUTRAL : BTN_PRIMARY
              }
            >
              <span className="inline-flex items-center gap-1.5">
                {microphone.on === false ? (
                  <MicOff className="h-3.5 w-3.5" />
                ) : (
                  <Mic className="h-3.5 w-3.5" />
                )}
                {microphone.on === null
                  ? t('uiLibrary.privacyMaskSettings.micUnknown', 'Microphone unknown')
                  : microphone.on
                    ? t('uiLibrary.privacyMaskSettings.micOn', 'Microphone on')
                    : t('uiLibrary.privacyMaskSettings.micOff', 'Microphone off')}
              </span>
            </button>
            <p className={`${TEXT_HINT} flex-1 leading-relaxed`}>
              {audioFailure !== null
                ? t('uiLibrary.privacyMaskSettings.writeFailed', 'Write failed: {{reason}}', {
                    reason: audioFailure,
                  })
                : microphone.on === null
                  ? t(
                      'uiLibrary.privacyMaskSettings.micNotReported',
                      'The camera did not report its microphone, so this state is unknown.',
                    )
                  : microphone.costWhenOff}
            </p>
          </div>
        )}
      </div>
    </WidgetPanel>
  )
}
