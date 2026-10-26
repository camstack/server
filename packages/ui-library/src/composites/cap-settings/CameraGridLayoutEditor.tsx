/**
 * The camera-grid layout editor.
 *
 * A grid's geometry is the one thing a DERIVED settings form cannot express: a
 * generated form renders "cell 1 source = 592, cell 1 crop x = 0.25, cell 1 crop
 * width = 0.5…" and nobody can hold a picture in their head from that. So the
 * geometry gets a widget — the canvas, drawn at the grid's own aspect ratio,
 * with the cells on it — while the knobs that ARE ordinary fields (the name,
 * the canvas size, the frame rate) sit beside it in the same panel.
 *
 * Every rectangle in here is NORMALIZED [0,1], on both sides: the crop taken
 * out of a source, and the cell it lands in. That is how the addon stores them
 * (a source camera can change resolution, and a stored pixel rectangle would
 * quietly start cutting the wrong region), so the editor speaks the same
 * language rather than converting at the boundary.
 *
 * The preview is the source cameras' own snapshots, positioned by CSS from the
 * SAME normalized numbers that will become the ffmpeg `crop`/`overlay`. It costs
 * the server nothing and it is wrong in exactly the ways the real composition
 * would be wrong.
 */
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import { useDeviceLabel } from '../device-name'
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import {
  AlertCircle,
  Grid2x2,
  LayoutGrid,
  Loader2,
  Maximize2,
  Plus,
  Save,
  Trash2,
} from 'lucide-react'
import { DeviceType, type DeviceInfo } from '@camstack/types'
import { useSystem } from '../../contexts/system-context.js'
import { useDeviceProxy } from '../../hooks/use-device-proxy.js'
import { useDevices } from '../../hooks/use-devices.js'
import { useDeviceSnapshotImage } from '../../hooks/use-device-snapshot.js'
import { WidgetPanel } from '../widget-panel.js'
import {
  autofillCellRects,
  clampNormalizedRect,
  moveNormalizedRect,
  parseGridView,
  resizeNormalizedRectFrom,
  type GridLayoutCell,
  type GridResizeHandle,
  type GridLayoutView,
  type GridNormalizedRect,
  type GridProfileOffer,
} from './camera-grid-layout.js'

const FULL_FRAME: GridNormalizedRect = { x: 0, y: 0, width: 1, height: 1 }
const MAX_CELLS = 16
/** Hoisted so `useDevices` does not re-subscribe on every render. */
const CAMERA_FILTER = { type: DeviceType.Camera } as const

export interface CameraGridLayoutEditorProps {
  readonly deviceId: number
}

/** What the editor knows about the grid right now. `undefined` = not yet asked. */
type LoadState = GridLayoutView | null | 'unreadable' | undefined

/**
 * A drag in progress.
 *
 * `target` is what is being dragged — the CELL (where the picture lands on the
 * canvas) or the SOURCE (which part of the camera is taken). They are two
 * different rectangles on two different canvases and the operator edits both by
 * hand now, so the state has to say which; a single `mode` could not.
 */
interface DragState {
  readonly index: number
  readonly target: 'cell' | 'source'
  readonly mode: 'move' | GridResizeHandle
  readonly startX: number
  readonly startY: number
  readonly origin: GridNormalizedRect
}

/**
 * A rectangle being dragged must not also PAN THE PAGE.
 *
 * On a phone a pointerdown on a `div` is a scroll gesture until the browser is
 * told otherwise, and `preventDefault` in the handler is too late — the browser
 * has already decided. `touch-action: none` is the only thing that makes a drag
 * work with a finger, and every surface that starts one carries it.
 */
const DRAG_SURFACE = { touchAction: 'none' } as const

/**
 * Finger-sized hit area around a grip.
 *
 * The visible square stays small (it sits ON the picture being edited and a big
 * one hides what it is positioning); the TOUCHABLE box around it is 24px, which
 * is the smallest target size that does not need a fingernail. The two are
 * different boxes on purpose — making the dot itself 24px would cover a quarter
 * of a small cell.
 */
const HANDLE_HIT = 'absolute flex h-6 w-6 items-center justify-center'

/** The eight grips, in the order they are drawn. */
const HANDLES: readonly GridResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const HANDLE_STYLE: Readonly<Record<GridResizeHandle, string>> = {
  nw: '-top-3 -left-3 cursor-nw-resize',
  n: '-top-3 left-1/2 -translate-x-1/2 cursor-n-resize',
  ne: '-top-3 -right-3 cursor-ne-resize',
  e: 'top-1/2 -right-3 -translate-y-1/2 cursor-e-resize',
  se: '-bottom-3 -right-3 cursor-se-resize',
  s: '-bottom-3 left-1/2 -translate-x-1/2 cursor-s-resize',
  sw: '-bottom-3 -left-3 cursor-sw-resize',
  w: 'top-1/2 -left-3 -translate-y-1/2 cursor-w-resize',
}

/**
 * Start a drag and KEEP it, even when the finger leaves the rectangle.
 *
 * Without pointer capture a drag ends the moment the pointer crosses the box it
 * started in — which on a phone is immediately, because the box is small and
 * the finger is not. With capture the events keep coming to the element that
 * was grabbed and still bubble to the canvas that does the arithmetic.
 */
function capturePointer(event: React.PointerEvent<HTMLElement>): void {
  event.currentTarget.setPointerCapture(event.pointerId)
}

/** Move or resize, from one drag and one delta. */
function applyDrag(drag: DragState, dx: number, dy: number): GridNormalizedRect {
  return drag.mode === 'move'
    ? moveNormalizedRect(drag.origin, dx, dy)
    : resizeNormalizedRectFrom(drag.origin, drag.mode, dx, dy)
}

export function CameraGridLayoutEditor({ deviceId }: CameraGridLayoutEditorProps): JSX.Element {
  const t = useUiText()
  const system = useSystem()
  // The proxies drive REACTIVITY (they change as devices come and go); the
  // infos carry the NAME, which a DeviceProxy deliberately does not.
  const cameraProxies = useDevices(CAMERA_FILTER)
  const cameras = useMemo(() => system.listDeviceInfos(CAMERA_FILTER), [system, cameraProxies])
  const [loaded, setLoaded] = useState<LoadState>(undefined)
  const [draft, setDraft] = useState<GridLayoutView | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const [drag, setDrag] = useState<DragState | null>(null)

  // The geometry is a CAPABILITY of this camera (`camera-grid-layout`), not an
  // addon action: the widget asks THE DEVICE, through the same proxy PTZ and
  // motion-zones use, and the framework is what mounted this widget here in the
  // first place. It used to reach the addon by name over `addons.custom`, which
  // is why it rendered nowhere the addon was not on a hand-written list.
  const dev = useDeviceProxy(system.trpcClient, deviceId)

  const reload = useCallback(async () => {
    const layout = dev?.cameraGridLayout
    if (!layout) return
    const outcome = parseGridView(await layout.getLayout({}))
    setLoaded(outcome)
    setDraft(outcome === null || outcome === 'unreadable' ? null : outcome)
  }, [dev])

  useEffect(() => {
    // `dev` is briefly null while the proxy resolves its bindings, and a camera
    // that does not bind the cap answers nothing at all. Neither is "not a
    // grid": the pending state stays pending until something answers (D315).
    if (!dev) return
    if (!dev.cameraGridLayout) {
      setLoaded(null)
      return
    }
    void reload().catch(() => {
      setLoaded('unreadable')
    })
  }, [dev, reload])

  const save = useCallback(
    async (extra?: { readonly publishedProfiles?: readonly ('high' | 'mid' | 'low')[] }) => {
      const layout = dev?.cameraGridLayout
      if (draft === null || !layout) return
      setSaving(true)
      setSaveError(null)
      try {
        const outcome = parseGridView(
          await layout.saveLayout({
            name: draft.name,
            fps: draft.fps,
            cells: draft.cells.map((cell) => ({ ...cell })),
            ...(extra?.publishedProfiles !== undefined
              ? { publishedProfiles: [...extra.publishedProfiles] }
              : {}),
          }),
        )
        if (outcome !== null && outcome !== 'unreadable') {
          setLoaded(outcome)
          setDraft(outcome)
        }
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : String(error))
      } finally {
        setSaving(false)
      }
    },
    [dev, draft],
  )

  const patchCell = useCallback((index: number, patch: Partial<GridLayoutCell>) => {
    setDraft((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            cells: prev.cells.map((cell, i) => (i === index ? { ...cell, ...patch } : cell)),
          },
    )
  }, [])

  /**
   * The shape the grid will actually come out as.
   *
   * The canvas is no longer a field: each profile derives its own from the
   * cells and the sources' dimensions, and the server reports what it came out
   * as. Drawing at that aspect is the only way the editor shows the truth —
   * before, it drew at whatever two numbers had been typed, which is exactly
   * how a layout could look right here and wrong on screen.
   *
   * 16:9 while nothing is offered yet: a grid with no cells has no shape, and
   * an empty editor has to be drawn at something.
   */
  const canvasAspect = useMemo(() => {
    const offered =
      loaded === undefined || loaded === null || loaded === 'unreadable' ? [] : loaded.profiles
    for (const row of offered) {
      if (!row.offered) continue
      const [width, height] = row.canvas.split('x').map(Number)
      if (width !== undefined && height !== undefined && width > 0 && height > 0) {
        return width / height
      }
    }
    return 16 / 9
  }, [loaded])

  // ── Read outcomes, kept distinct ───────────────────────────────────────
  if (loaded === undefined) {
    return (
      <WidgetPanel
        title={t('uiLibrary.cameraGridLayout.title', 'Grid layout')}
        icon={<Grid2x2 className="h-3.5 w-3.5" />}
      >
        <div className="flex items-center gap-2 text-[10.5px] text-foreground-subtle">
          <Loader2 className="h-3 w-3 animate-spin" />{' '}
          {t('uiLibrary.cameraGridLayout.loading', 'Loading the layout…')}
        </div>
      </WidgetPanel>
    )
  }
  if (loaded === 'unreadable') {
    return (
      <WidgetPanel
        title={t('uiLibrary.cameraGridLayout.title', 'Grid layout')}
        icon={<Grid2x2 className="h-3.5 w-3.5" />}
      >
        <div className="flex items-center gap-2 text-[10.5px] text-danger">
          <AlertCircle className="h-3 w-3" />
          {t(
            'uiLibrary.cameraGridLayout.unreadable',
            'The Camera Grids addon did not answer, so this layout is unknown — not empty.',
          )}
        </div>
      </WidgetPanel>
    )
  }
  if (loaded === null || draft === null) {
    return (
      <WidgetPanel
        title={t('uiLibrary.cameraGridLayout.title', 'Grid layout')}
        icon={<Grid2x2 className="h-3.5 w-3.5" />}
      >
        <div className="text-[10.5px] text-foreground-subtle">
          {t('uiLibrary.cameraGridLayout.notGrid', 'This camera is not a grid.')}
        </div>
      </WidgetPanel>
    )
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag === null) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width === 0 || bounds.height === 0) return
    if (drag.target !== 'cell') return
    const dx = (event.clientX - drag.startX) / bounds.width
    const dy = (event.clientY - drag.startY) / bounds.height
    patchCell(drag.index, { cell: applyDrag(drag, dx, dy) })
  }

  return (
    <WidgetPanel
      title={t('uiLibrary.cameraGridLayout.title', 'Grid layout')}
      icon={<Grid2x2 className="h-3.5 w-3.5" />}
      headerRight={
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={draft.cells.length === 0}
            title={t(
              'uiLibrary.cameraGridLayout.autofillTitle',
              'Tile every cell over the whole canvas, leaving no gap',
            )}
            onClick={() => {
              // Placement only. The crop each cell takes from its camera is left
              // exactly as the operator set it — autofill answers "where does
              // this land", never "what does it show".
              const rects = autofillCellRects(draft.cells.length)
              setDraft({
                ...draft,
                cells: draft.cells.map((cell, index) => ({
                  ...cell,
                  cell: rects[index] ?? cell.cell,
                })),
              })
            }}
            className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] uppercase"
          >
            <LayoutGrid className="h-3 w-3" />{' '}
            {t('uiLibrary.cameraGridLayout.autofill', 'Autofill')}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] uppercase"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            {t('uiLibrary.cameraGridLayout.save', 'Save')}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {saveError !== null && (
          <div className="flex items-center gap-2 text-[10.5px] text-danger">
            <AlertCircle className="h-3 w-3" /> {saveError}
          </div>
        )}

        {/* ── the canvas ─────────────────────────────────────────────── */}
        <div
          className="relative w-full select-none overflow-hidden rounded border border-border bg-black"
          style={{ aspectRatio: String(canvasAspect), ...DRAG_SURFACE }}
          onPointerMove={onPointerMove}
          onPointerUp={() => {
            setDrag(null)
          }}
          onPointerCancel={() => {
            setDrag(null)
          }}
        >
          {draft.cells.map((cell, index) => (
            <GridCellBox
              key={`${String(cell.deviceId)}-${String(index)}`}
              cell={cell}
              selected={index === selected}
              onSelect={() => {
                setSelected(index)
              }}
              onDragStart={(mode, event) => {
                setSelected(index)
                setDrag({
                  index,
                  target: 'cell',
                  mode,
                  startX: event.clientX,
                  startY: event.clientY,
                  origin: cell.cell,
                })
              }}
            />
          ))}
          {draft.cells.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-[10.5px] text-foreground-subtle">
              {t('uiLibrary.cameraGridLayout.noCells', 'No cells yet — add one below.')}
            </div>
          )}
        </div>

        {/* ── the non-spatial knobs, beside the picture they describe ── */}
        <div className="grid grid-cols-4 gap-2 text-[10.5px]">
          {/* No Width/Height. A grid's resolution is derived per profile from
              the cells and the sources' own dimensions — see the report below
              for what each one came out as. */}
          <LabelledNumber
            label="FPS"
            value={draft.fps}
            onChange={(fps) => {
              setDraft({ ...draft, fps })
            }}
          />
          <button
            type="button"
            disabled={draft.cells.length >= MAX_CELLS}
            onClick={() => {
              const first = cameras.find((camera) => camera.id !== deviceId)
              if (!first) return
              setDraft({
                ...draft,
                cells: [
                  ...draft.cells,
                  {
                    deviceId: first.id,
                    source: FULL_FRAME,
                    cell: clampNormalizedRect({ x: 0.1, y: 0.1, width: 0.4, height: 0.4 }),
                  },
                ],
              })
              setSelected(draft.cells.length)
            }}
            className="flex items-center justify-center gap-1 self-end rounded border border-border px-2 py-1 uppercase"
          >
            <Plus className="h-3 w-3" /> {t('uiLibrary.cameraGridLayout.addCell', 'Cell')}
          </button>
        </div>

        {/* ── what this grid can actually publish, and what stops it ── */}
        <GridProfileReport
          offers={loaded.profiles}
          cameras={cameras}
          onToggle={(profile) => {
            if (draft === null) return
            const current = loaded.profiles.filter((row) => row.published).map((row) => row.profile)
            const next = current.includes(profile)
              ? current.filter((entry) => entry !== profile)
              : [...current, profile]
            void save({ publishedProfiles: next })
          }}
        />

        {/* ── the selected cell: its source, and the crop taken from it ─ */}
        {draft.cells[selected] !== undefined && (
          <CellInspector
            cell={draft.cells[selected]}
            index={selected}
            cameras={cameras.filter((camera) => camera.id !== deviceId)}
            onChange={(patch) => {
              patchCell(selected, patch)
            }}
            onRemove={() => {
              setDraft({
                ...draft,
                cells: draft.cells.filter((_, i) => i !== selected),
              })
              setSelected(0)
            }}
          />
        )}
      </div>
    </WidgetPanel>
  )
}

interface GridProfileReportProps {
  readonly onToggle: (profile: 'high' | 'mid' | 'low') => void
  readonly offers: readonly GridProfileOffer[]
  readonly cameras: readonly DeviceInfo[]
}

/**
 * The honest report. A grid's `high` composes its sources' `high` and its `low`
 * their `low`, so a profile is on offer only when EVERY source can serve it —
 * and the refusal names the source, because "this grid has no low" is not
 * something an operator can act on and "101 has no low" is.
 *
 * Read-only on purpose: what is on offer is decided by the source cameras'
 * assignments, and a control here would be a switch that writes nothing (D62).
 */
function GridProfileReport({ offers, cameras, onToggle }: GridProfileReportProps) {
  const t = useUiText()
  const nameOf = (deviceId: number): string =>
    cameras.find((camera) => camera.id === deviceId)?.name ?? `#${String(deviceId)}`
  return (
    <div className="flex flex-col gap-1 rounded border border-border p-2 text-[10.5px]">
      <span className="uppercase text-foreground-subtle">
        {t('uiLibrary.cameraGridLayout.published', 'Published profiles')}
      </span>
      {offers.map((offer) => (
        <div key={offer.profile} className="flex items-baseline gap-2">
          {/* Only a SERVICEABLE profile can be toggled: the checkbox says what
              this grid publishes, never what its cameras can do. */}
          <input
            type="checkbox"
            checked={offer.published}
            disabled={!offer.offered}
            aria-label={t('uiLibrary.cameraGridLayout.publish', 'publish {{profile}}', {
              profile: offer.profile,
            })}
            onChange={() => {
              onToggle(offer.profile)
            }}
          />
          <span className="w-10 uppercase">{offer.profile}</span>
          {offer.offered ? (
            <span className="text-foreground-subtle">
              {offer.canvas} —{' '}
              {offer.published
                ? t(
                    'uiLibrary.cameraGridLayout.composed',
                    'composed from every source’s {{profile}}',
                    { profile: offer.profile },
                  )
                : t('uiLibrary.cameraGridLayout.serviceable', 'serviceable, not published')}
            </span>
          ) : (
            <span className="text-danger">
              {offer.missingSources.length === 0
                ? t(
                    'uiLibrary.cameraGridLayout.noCellsOffer',
                    'not offered — this grid has no cells yet',
                  )
                : t(
                    'uiLibrary.cameraGridLayout.missing',
                    'not offered — no {{profile}} on {{sources}}',
                    {
                      profile: offer.profile,
                      sources: offer.missingSources.map(nameOf).join(', '),
                    },
                  )}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

interface GridCellBoxProps {
  readonly cell: GridLayoutCell
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onDragStart: (mode: 'move' | GridResizeHandle, event: React.PointerEvent) => void
}

function GridCellBox({ cell, selected, onSelect, onDragStart }: GridCellBoxProps) {
  const { src } = useDeviceSnapshotImage(cell.deviceId, { width: 640 })
  // The SAME normalized crop the ffmpeg graph will apply, expressed as a
  // background window: a source rect of half the width is a background twice
  // as wide, offset to the rect's own origin.
  const backgroundSize = `${String(100 / cell.source.width)}% ${String(100 / cell.source.height)}%`
  const backgroundPosition =
    cell.source.width >= 1 && cell.source.height >= 1
      ? 'center'
      : `${String((cell.source.x / Math.max(1e-6, 1 - cell.source.width)) * 100)}% ` +
        `${String((cell.source.y / Math.max(1e-6, 1 - cell.source.height)) * 100)}%`
  return (
    <div
      role="presentation"
      onPointerDown={(event) => {
        onSelect()
        capturePointer(event)
        onDragStart('move', event)
      }}
      className={`absolute cursor-move border ${selected ? 'border-accent' : 'border-border/60'}`}
      style={{
        ...DRAG_SURFACE,
        left: `${String(cell.cell.x * 100)}%`,
        top: `${String(cell.cell.y * 100)}%`,
        width: `${String(cell.cell.width * 100)}%`,
        height: `${String(cell.cell.height * 100)}%`,
        backgroundImage: src === null ? undefined : `url(${src})`,
        backgroundSize,
        backgroundPosition,
        backgroundRepeat: 'no-repeat',
      }}
    >
      {/* The grips appear on the SELECTED cell only. Eight of them on every
          cell at once would cover a four-camera canvas in dots and make the
          picture — the thing being edited — unreadable. */}
      {selected &&
        HANDLES.map((handle) => (
          <div
            key={handle}
            role="presentation"
            onPointerDown={(event) => {
              event.stopPropagation()
              capturePointer(event)
              onDragStart(handle, event)
            }}
            className={`${HANDLE_HIT} ${HANDLE_STYLE[handle]}`}
            style={DRAG_SURFACE}
          >
            <span className="h-2.5 w-2.5 bg-accent" />
          </div>
        ))}
    </div>
  )
}

interface CameraOptionLabelProps {
  readonly camera: DeviceInfo
}

function CameraOptionLabel({ camera }: CameraOptionLabelProps): string {
  return useDeviceLabel(camera, 'compact')
}

interface CellInspectorProps {
  readonly cell: GridLayoutCell
  readonly index: number
  readonly cameras: readonly DeviceInfo[]
  readonly onChange: (patch: Partial<GridLayoutCell>) => void
  readonly onRemove: () => void
}

function CellInspector({ cell, index, cameras, onChange, onRemove }: CellInspectorProps) {
  const t = useUiText()
  return (
    <div className="flex flex-col gap-2 rounded border border-border p-2 text-[10.5px]">
      <div className="flex items-center justify-between">
        <span className="uppercase text-foreground-subtle">
          {t('uiLibrary.cameraGridLayout.cellN', 'Cell {{index}}', { index: index + 1 })}
        </span>
        <button type="button" onClick={onRemove} className="text-danger">
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      <label className="flex items-center gap-2">
        <span className="w-16 text-foreground-subtle">
          {t('uiLibrary.cameraGridLayout.source', 'Source')}
        </span>
        <select
          value={String(cell.deviceId)}
          onChange={(event) => {
            onChange({ deviceId: Number(event.target.value) })
          }}
          className="flex-1 rounded border border-border bg-transparent px-1 py-0.5"
        >
          {cameras.map((camera) => (
            <option key={camera.id} value={String(camera.id)}>
              <CameraOptionLabel camera={camera} />
            </option>
          ))}
        </select>
      </label>
      {/* The part of the camera this cell shows, dragged on the camera's own
          picture. The numbers below still work and are the way to type an exact
          value; they are no longer the ONLY way, which is what made a crop a
          guess-and-check exercise. */}
      <SourceCropEditor
        deviceId={cell.deviceId}
        source={cell.source}
        onChange={(source) => {
          onChange({ source })
        }}
      />
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {(['x', 'y', 'width', 'height'] as const).map((key) => (
          <CropSlider
            key={key}
            label={cropLabel(t, key)}
            value={cell.source[key]}
            onChange={(next) => {
              onChange({ source: clampNormalizedRect({ ...cell.source, [key]: next }) })
            }}
          />
        ))}
      </div>
    </div>
  )
}

interface SourceCropEditorProps {
  readonly deviceId: number
  readonly source: GridNormalizedRect
  readonly onChange: (source: GridNormalizedRect) => void
}

/**
 * The crop, on the source camera's own frame.
 *
 * The whole snapshot is drawn at full opacity behind a dimmed overlay, and the
 * selected rectangle is the hole in it: what is INSIDE is what the grid will
 * show. Drawing it the other way round — bright rectangle on a dark picture —
 * reads as "this part is highlighted", which is not the same claim.
 *
 * Its drag state is local. The canvas above owns cell placement and this owns
 * the crop; sharing one drag state would mean every pointer move on either
 * canvas consulted a `target` discriminator to decide whether it was for the
 * other one.
 */
function SourceCropEditor({ deviceId, source, onChange }: SourceCropEditorProps) {
  const t = useUiText()
  const { src } = useDeviceSnapshotImage(deviceId, { width: 640 })
  const [drag, setDrag] = useState<Omit<DragState, 'index' | 'target'> | null>(null)
  // The camera's OWN frame shape, measured from the snapshot.
  //
  // This box used to be hard-coded to 16:9 with an `object-cover` image, which
  // silently CUT a source that is not 16:9 — so the rectangle drawn here was
  // measured against a cropped picture and did not mean what the addon would
  // apply. The crop is normalized against the WHOLE frame, so the frame has to
  // be what is on screen, whole.
  const [sourceAspect, setSourceAspect] = useState<number | null>(null)

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag === null) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width === 0 || bounds.height === 0) return
    onChange(
      applyDrag(
        { ...drag, index: 0, target: 'source' },
        (event.clientX - drag.startX) / bounds.width,
        (event.clientY - drag.startY) / bounds.height,
      ),
    )
  }

  const full = source.x === 0 && source.y === 0 && source.width === 1 && source.height === 1

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="uppercase text-foreground-subtle">
          {t('uiLibrary.cameraGridLayout.visiblePart', 'Visible part of the camera')}
        </span>
        <button
          type="button"
          disabled={full}
          onClick={() => {
            onChange(FULL_FRAME)
          }}
          className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 uppercase disabled:opacity-40"
        >
          <Maximize2 className="h-3 w-3" />{' '}
          {t('uiLibrary.cameraGridLayout.wholeFrame', 'Whole frame')}
        </button>
      </div>
      <div
        className="relative w-full select-none overflow-hidden rounded border border-border bg-black"
        style={{ aspectRatio: String(sourceAspect ?? 16 / 9), ...DRAG_SURFACE }}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          setDrag(null)
        }}
        onPointerCancel={() => {
          setDrag(null)
        }}
      >
        {src === null ? (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-foreground-subtle">
            {t(
              'uiLibrary.cameraGridLayout.noSnapshot',
              'No snapshot from this camera yet — the numbers below still apply.',
            )}
          </div>
        ) : (
          <img
            src={src}
            alt=""
            className="absolute inset-0 h-full w-full"
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget
              if (naturalWidth > 0 && naturalHeight > 0) {
                setSourceAspect(naturalWidth / naturalHeight)
              }
            }}
          />
        )}
        {/* Everything outside the crop is dimmed, so the rectangle reads as a
            window rather than as a highlight. */}
        <div className="pointer-events-none absolute inset-0 bg-black/55" />
        <div
          role="presentation"
          onPointerDown={(event) => {
            capturePointer(event)
            setDrag({
              mode: 'move',
              startX: event.clientX,
              startY: event.clientY,
              origin: source,
            })
          }}
          className="absolute cursor-move border border-accent"
          style={{
            ...DRAG_SURFACE,
            left: `${String(source.x * 100)}%`,
            top: `${String(source.y * 100)}%`,
            width: `${String(source.width * 100)}%`,
            height: `${String(source.height * 100)}%`,
            backgroundImage: src === null ? undefined : `url(${src})`,
            backgroundSize: `${String(100 / source.width)}% ${String(100 / source.height)}%`,
            backgroundPosition:
              source.width >= 1 && source.height >= 1
                ? 'center'
                : `${String((source.x / Math.max(1e-6, 1 - source.width)) * 100)}% ` +
                  `${String((source.y / Math.max(1e-6, 1 - source.height)) * 100)}%`,
          }}
        >
          {HANDLES.map((handle) => (
            <div
              key={handle}
              role="presentation"
              onPointerDown={(event) => {
                event.stopPropagation()
                capturePointer(event)
                setDrag({
                  mode: handle,
                  startX: event.clientX,
                  startY: event.clientY,
                  origin: source,
                })
              }}
              className={`${HANDLE_HIT} ${HANDLE_STYLE[handle]}`}
              style={DRAG_SURFACE}
            >
              <span className="h-2.5 w-2.5 bg-accent" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function cropLabel(t: UiTextFn, key: 'x' | 'y' | 'width' | 'height'): string {
  switch (key) {
    case 'x':
      return t('uiLibrary.cameraGridLayout.cropX', 'Crop x')
    case 'y':
      return t('uiLibrary.cameraGridLayout.cropY', 'Crop y')
    case 'width':
      return t('uiLibrary.cameraGridLayout.cropWidth', 'Crop width')
    case 'height':
      return t('uiLibrary.cameraGridLayout.cropHeight', 'Crop height')
  }
}

interface CropSliderProps {
  readonly label: string
  readonly value: number
  readonly onChange: (value: number) => void
}

/**
 * One crop number, as a slider AND as a number.
 *
 * The slider is what makes this usable with a thumb — a `number` input on a
 * phone opens a keyboard, and adjusting a crop by typing 0.37 then 0.39 then
 * 0.38 is not adjusting, it is guessing. The typed field stays because a slider
 * cannot express "exactly a third" and because a value you can read is how you
 * copy a crop from one cell to another.
 *
 * Both write through `clampNormalizedRect` upstream, so neither can hand the
 * addon a rectangle that leaves the frame — it THROWS on one, by design.
 */
function CropSlider({ label, value, onChange }: CropSliderProps) {
  const rounded = Math.round(value * 100) / 100
  return (
    <label className="flex flex-col gap-0.5">
      <span className="flex items-baseline justify-between text-foreground-subtle">
        <span>{label}</span>
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={rounded}
          onChange={(event) => {
            const next = Number(event.target.value)
            if (Number.isFinite(next)) onChange(next)
          }}
          className="w-12 rounded border border-border bg-transparent px-1 py-0.5 text-right"
        />
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.005}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next)) onChange(next)
        }}
        // A range input is a drag too: without this the page scrolls instead.
        style={DRAG_SURFACE}
        className="h-5 w-full accent-accent"
      />
    </label>
  )
}

interface LabelledNumberProps {
  readonly label: string
  readonly value: number
  readonly step?: number
  readonly onChange: (value: number) => void
}

function LabelledNumber({ label, value, step = 1, onChange }: LabelledNumberProps) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-foreground-subtle">{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next)) onChange(next)
        }}
        className="rounded border border-border bg-transparent px-1 py-0.5"
      />
    </label>
  )
}
