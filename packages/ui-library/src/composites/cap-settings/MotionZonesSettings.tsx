/**
 * MotionZonesSettings — management surface for the on-camera
 * `motion-zones` capability. A cap-settings component (ui-library),
 * mounted into the device-detail Config tab via the cap-UI
 * contribution mechanism (the `motion-zones` cap declares a `ui` block).
 *
 * The on-camera motion mask is a SINGLE `grid` region in the shared
 * MaskShape vocabulary (a row-major boolean cell lattice). This component
 * owns its own control panel (Edit toggle, All on / All off / Invert,
 * count, Revert, Save) and paints the editable lattice over the live frame
 * with the shared `MaskShapeCanvas` drawing-plane — registered as a
 * player-overlay layer ONLY while "Edit grid" is toggled on (OFF by
 * default — nothing draws on mount).
 *
 * Detection enable + sensitivity are NOT edited here — they are the
 * camera's on-board motion master switch, owned by the driver's
 * "On-camera motion" settings section. Saving sends a `cells`-only patch
 * (one grid region); enable / sensitivity are left untouched camera-side.
 *
 * ── Resizable input grid (resampled to the camera grid on save) ──────────────
 * The camera's native motion grid (`getOptions().grid`, e.g. 22×18) is the
 * FINEST resolution that round-trips — painting finer than it can't be stored
 * (not reconstructible). So the camera grid is the FLOOR (×1) and the operator
 * picks BIGGER cells: an integer cell-size multiplier (×1/×2/×3) where a UI cell
 * spans an m×m block of camera cells (×2 → quarter as many, ×3 → ninth). The
 * CAMERA grid stays authoritative:
 *   - LOAD: the camera grid is COARSENED into the chosen UI resolution (a UI
 *     cell is `true` if ANY camera cell in its block is painted) so existing
 *     masks display on the bigger-celled surface.
 *   - SAVE: the UI grid is EXPANDED back to camera gridWidth×gridHeight — every
 *     camera cell takes the value of the UI cell whose block covers it.
 * At ×1 both transforms are the identity, so the camera-grid round-trip is
 * exact; at higher multipliers `coarsen(expand(uiCells)) === uiCells`, so an
 * edit made at the chosen resolution survives the round-trip exactly. The
 * component's draft (`uiCells`) lives at the UI resolution; the last-saved truth
 * (`committedCamera`) and every comparison stay anchored to the camera-native
 * grid so `dirty`/Save/Revert math is resolution-independent.
 */
import { useUiText, UiTrans } from '../../contexts/ui-text'
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Grid2x2 } from 'lucide-react'
import type { MaskGridShape, MaskShape, MotionZoneOptions } from '@camstack/types'
import { useDeviceProxy } from '../../hooks/use-device-proxy'
import { useSystem } from '../../contexts/system-context'
import { usePlayerOverlayLayer } from '../../contexts/player-overlays'
import { TEXT_HINT } from '../../lib/responsive'
import { isAbsentProvider } from '../../lib/cap-error'
import { MaskShapeCanvas, type MaskShapeItem } from './MaskShapeCanvas'
import { WidgetPanel } from '../widget-panel'
import type { CapSettingsComponentProps } from './index'

// Motion-zones overlay sits above the analytics zones overlay (order 100).
const MOTION_ZONES_OVERLAY_ORDER = 110
const OVERLAY_ID = 'motion-zones'
// The cap stores exactly one grid region today (id 0).
const GRID_REGION_ID = 0

// Selectable cell-size multipliers over the camera-native grid. ×1 is the
// camera grid itself (the FINEST / floor — painting finer isn't reconstructible);
// higher values give BIGGER cells (a coarser painting surface): a UI cell spans
// an m×m block of camera cells.
const GRID_MULTIPLIERS: readonly number[] = [1, 2, 3]
const DEFAULT_MULTIPLIER = 1

const BTN_NEUTRAL =
  'rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-medium text-foreground-subtle hover:bg-surface-hover disabled:opacity-40 transition-colors'
const BTN_PRIMARY =
  'rounded-md border border-primary/50 bg-primary/15 px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/25 disabled:opacity-40 transition-colors'

/** Coerce an arbitrary `cells` array to exactly `width*height` booleans. */
function normaliseCells(cells: readonly boolean[], width: number, height: number): boolean[] {
  const total = width * height
  const next: boolean[] = Array.from({ length: total })
  for (let i = 0; i < total; i += 1) next[i] = cells[i] === true
  return next
}

function cellsEqual(a: readonly boolean[], b: readonly boolean[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/** UI-grid dimension for a camera dimension at cell-size multiplier m. */
function coarseDim(cameraDim: number, m: number): number {
  return Math.ceil(cameraDim / m)
}

/**
 * Map a camera-grid index to the UI-grid cell that SPATIALLY covers it, by the
 * camera cell's centre (`(c + 0.5)/cameraDim`). Index-based `floor(c/m)` drifts
 * when the camera dim isn't a multiple of m (e.g. 22 ÷ 3) — the painted UI cell
 * no longer lines up with the camera region it masks. The centre map keeps them
 * aligned and is a non-decreasing surjection onto [0, uiDim), so every UI cell
 * owns ≥1 camera cell — which is what makes `coarsen(expand(x)) === x` hold.
 */
function cameraToUi(c: number, cameraDim: number, uiDim: number): number {
  return Math.min(uiDim - 1, Math.floor(((c + 0.5) / cameraDim) * uiDim))
}

/**
 * COARSEN a camera-native grid (cw×ch, row-major) into a coarser UI grid at
 * ceil(cw/m)×ceil(ch/m): a UI cell is `true` if ANY camera cell mapped into it
 * is painted (the inclusive "any" rule — motion masks are inclusive, so a
 * painted sub-region arms the whole bigger cell). At m === 1 this is the
 * identity. Used on LOAD/Revert so an existing camera mask shows up on the
 * chosen (bigger-celled) painting surface.
 */
function coarsenCells(
  cameraCells: readonly boolean[],
  cw: number,
  ch: number,
  m: number,
): boolean[] {
  const uw = coarseDim(cw, m)
  const uh = coarseDim(ch, m)
  const out: boolean[] = Array.from({ length: uw * uh }, () => false)
  for (let cy = 0; cy < ch; cy += 1) {
    const uy = cameraToUi(cy, ch, uh)
    for (let cx = 0; cx < cw; cx += 1) {
      if (cameraCells[cy * cw + cx] !== true) continue
      out[uy * uw + cameraToUi(cx, cw, uw)] = true
    }
  }
  return out
}

/**
 * EXPAND a coarser UI grid at ceil(cw/m)×ceil(ch/m) back to the camera-native
 * grid (cw×ch): every camera cell takes the value of the UI cell that spatially
 * covers it. At m === 1 this is the identity, so the camera-grid round-trip is
 * exact. Used on SAVE, on multiplier changes (to preserve painted area), and to
 * compute `dirty`. Note `coarsen(expand(uiCells)) === uiCells`, so an edit made
 * at the chosen resolution survives the round-trip exactly.
 */
function expandCells(uiCells: readonly boolean[], cw: number, ch: number, m: number): boolean[] {
  const uw = coarseDim(cw, m)
  const uh = coarseDim(ch, m)
  const out: boolean[] = Array.from({ length: cw * ch }, () => false)
  for (let cy = 0; cy < ch; cy += 1) {
    const uy = cameraToUi(cy, ch, uh)
    for (let cx = 0; cx < cw; cx += 1) {
      out[cy * cw + cx] = uiCells[uy * uw + cameraToUi(cx, cw, uw)] === true
    }
  }
  return out
}

export function MotionZonesSettings({ deviceId }: CapSettingsComponentProps): JSX.Element | null {
  const t = useUiText()
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)

  const [options, setOptions] = useState<MotionZoneOptions | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  // The draft lives at the UI (painting) resolution = camera grid × multiplier.
  const [uiCells, setUiCells] = useState<readonly boolean[] | null>(null)
  // Last-saved truth, ALWAYS at the camera-native resolution (authoritative).
  const [committedCamera, setCommittedCamera] = useState<readonly boolean[] | null>(null)
  // UI-grid multiplier over the camera grid (×1 = exact round-trip).
  const [multiplier, setMultiplier] = useState(DEFAULT_MULTIPLIER)
  const [saving, setSaving] = useState(false)
  // Explicit edit mode — the editable lattice paints over the live frame
  // ONLY while toggled on. Default OFF: nothing draws on mount.
  const [editing, setEditing] = useState(false)

  // Load grid dims + seed the draft from a fresh getStatus(). A getOptions
  // failure self-gates the editor (camera has no cap). `dev` is briefly null
  // while the proxy initialises — the effect re-runs when it resolves.
  const seededRef = useRef(false)
  useEffect(() => {
    if (!dev) return undefined
    let cancelled = false
    seededRef.current = false
    setOptions(null)
    setUnsupported(false)
    setUiCells(null)
    setCommittedCamera(null)
    setMultiplier(DEFAULT_MULTIPLIER)
    setEditing(false)
    void (async () => {
      try {
        const opts = await dev.motionZones?.getOptions({})
        if (cancelled) return
        if (!opts) throw new Error('device proxy not ready')
        setOptions(opts)
        if (seededRef.current) return
        const status = await dev.motionZones?.getStatus({})
        if (cancelled) return
        if (!status) throw new Error('device proxy not ready')
        seededRef.current = true
        const region = status.regions.find((r) => r.shape.kind === 'grid')
        const raw = region ? region.shape.cells : []
        const norm = normaliseCells(raw, opts.grid.width, opts.grid.height)
        setCommittedCamera(norm)
        // Seed the UI draft at the default ×1 multiplier (identity coarsen).
        setUiCells(coarsenCells(norm, opts.grid.width, opts.grid.height, DEFAULT_MULTIPLIER))
      } catch (err: unknown) {
        if (cancelled) return
        if (isAbsentProvider(err)) setUnsupported(true)
        // eslint-disable-next-line no-console -- error-path diagnostic; UI code has no scoped logger
        else console.error('Motion Zones load failed', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dev])

  const cw = options ? options.grid.width : 0
  const ch = options ? options.grid.height : 0
  const uiWidth = coarseDim(cw, multiplier)
  const uiHeight = coarseDim(ch, multiplier)

  // `dirty` compares at the CAMERA-NATIVE resolution: expand the UI draft up to
  // the camera grid and diff against the last-saved camera truth. This keeps the
  // test exact and resolution-independent (a coarser painting grid that resolves
  // to the same camera mask is correctly "not dirty").
  const draftCamera = useMemo(
    () => (uiCells && options ? expandCells(uiCells, cw, ch, multiplier) : null),
    [uiCells, options, cw, ch, multiplier],
  )
  const dirty = useMemo(
    () =>
      draftCamera !== null && committedCamera !== null && !cellsEqual(draftCamera, committedCamera),
    [draftCamera, committedCamera],
  )
  // Active count is shown at the CAMERA grid (the authoritative cells), so the
  // number is stable across UI-grid resolutions.
  const activeCount = useMemo(
    () => (draftCamera ? draftCamera.reduce((n, c) => (c ? n + 1 : n), 0) : 0),
    [draftCamera],
  )
  const cameraTotal = cw * ch
  const uiTotal = uiWidth * uiHeight

  const setAll = useCallback(
    (value: boolean): void => {
      if (uiTotal > 0) setUiCells(Array.from({ length: uiTotal }, () => value))
    },
    [uiTotal],
  )
  const invert = useCallback((): void => {
    setUiCells((prev) => (prev ? prev.map((c) => !c) : prev))
  }, [])
  const revert = useCallback((): void => {
    if (committedCamera && options) setUiCells(coarsenCells(committedCamera, cw, ch, multiplier))
  }, [committedCamera, options, cw, ch, multiplier])

  // Change the cell size WITHOUT losing paint: expand the current UI draft up to
  // the camera grid (preserving painted area) then coarsen into the new UI
  // resolution. ×1↔×N transitions are lossless at the camera grain.
  const changeMultiplier = useCallback(
    (next: number): void => {
      if (next === multiplier || !options) return
      setUiCells((prev) => {
        if (!prev) {
          setMultiplier(next)
          return prev
        }
        const cameraGrid = expandCells(prev, cw, ch, multiplier)
        const recoarsened = coarsenCells(cameraGrid, cw, ch, next)
        setMultiplier(next)
        return recoarsened
      })
    },
    [multiplier, options, cw, ch],
  )

  // ── Canvas ↔ draft mapping ───────────────────────────────────────────────
  // One drawing-plane item — the single grid region sized at the UI resolution.
  const items = useMemo<MaskShapeItem[]>(
    () =>
      options && uiCells
        ? [
            {
              id: GRID_REGION_ID,
              shape: {
                kind: 'grid',
                gridWidth: uiWidth,
                gridHeight: uiHeight,
                cells: [...uiCells],
              },
            },
          ]
        : [],
    [options, uiCells, uiWidth, uiHeight],
  )

  // Controlled edit — the canvas' cell-paint gesture commits a new grid shape at
  // the UI resolution; the camera-native resample happens on save.
  const onShapeChange = useCallback((_id: string | number, shape: MaskShape): void => {
    if (shape.kind !== 'grid') return
    setUiCells(shape.cells)
  }, [])

  const save = useCallback(async (): Promise<void> => {
    if (!dev || !uiCells || !options) return
    setSaving(true)
    try {
      // Expand the UI draft back to the camera-native grid before sending —
      // the camera spec stays authoritative. At ×1 this is the identity.
      const cameraCells = expandCells(uiCells, options.grid.width, options.grid.height, multiplier)
      const shape: MaskGridShape = {
        kind: 'grid',
        gridWidth: options.grid.width,
        gridHeight: options.grid.height,
        cells: cameraCells,
      }
      await dev.motionZones?.setZone({
        patch: { regions: [{ id: GRID_REGION_ID, enabled: true, shape }] },
      })
      const fresh = await dev.motionZones?.getStatus({})
      if (fresh) {
        const region = fresh.regions.find((r) => r.shape.kind === 'grid')
        const raw = region ? region.shape.cells : []
        const norm = normaliseCells(raw, options.grid.width, options.grid.height)
        setCommittedCamera(norm)
        setUiCells(coarsenCells(norm, options.grid.width, options.grid.height, multiplier))
      }
    } catch (err: unknown) {
      // eslint-disable-next-line no-console -- error-path diagnostic; UI code has no scoped logger
      console.error('Motion Zones save failed', err)
    } finally {
      setSaving(false)
    }
  }, [dev, uiCells, options, multiplier])

  // Register the lattice overlay ONLY while editing — default OFF, nothing
  // paints over the live stream on mount. `null` also covers the pre-load /
  // unsupported states; the hook stays unconditional for a stable hook order.
  const overlaySpec = useMemo(
    () =>
      editing && !unsupported && options && uiCells
        ? {
            id: OVERLAY_ID,
            order: MOTION_ZONES_OVERLAY_ORDER,
            node: (
              <MaskShapeCanvas
                transparent
                items={items}
                supportedShapes={['grid']}
                grid={{ width: uiWidth, height: uiHeight }}
                selectedId={GRID_REGION_ID}
                onSelect={() => {}}
                onShapeChange={onShapeChange}
                onDrawComplete={() => {}}
                drawingKind={null}
              />
            ),
          }
        : null,
    [editing, unsupported, options, uiCells, items, onShapeChange, uiWidth, uiHeight],
  )
  usePlayerOverlayLayer(overlaySpec)

  const ready = !unsupported && options !== null && uiCells !== null

  // Don't mount until the device proxy is ready — calling a cap method with a
  // null proxy throws a transient "not ready" error that's harmless init noise.
  if (!dev) return null

  return (
    <WidgetPanel
      title={t('uiLibrary.motionZones.title', 'Motion Zones')}
      icon={<Grid2x2 className="h-3.5 w-3.5 text-foreground-subtle" />}
    >
      <div className="flex flex-col gap-3">
        {unsupported ? (
          <p className={`${TEXT_HINT} leading-relaxed`}>
            {t(
              'uiLibrary.motionZones.unsupported',
              "This camera doesn't expose an on-board motion zones grid.",
            )}
          </p>
        ) : !ready ? (
          <p className={`${TEXT_HINT} leading-relaxed`}>
            {t('uiLibrary.motionZones.loading', "Loading the camera's grid…")}
          </p>
        ) : (
          <>
            <p className={`${TEXT_HINT} leading-relaxed`}>
              <UiTrans
                uiKey="uiLibrary.motionZones.intro"
                fallback="Toggle <0>Edit grid</0> to paint the region directly on the live frame, then <1>Save</1> to push the mask to the camera. Pick a bigger <2>Cell size</2> for quicker, broad-stroke painting — it's resampled to the camera's native {{width}}×{{height}} grid on save (×1 is the finest)."
                components={[
                  <strong key="e" className="text-foreground" />,
                  <strong key="s" className="text-foreground" />,
                  <strong key="c" className="text-foreground" />,
                ]}
                values={{ width: options.grid.width, height: options.grid.height }}
              />
            </p>

            {/* Action row — edit-mode toggle + quick actions + Revert + Save
                 all on ONE row (wraps when narrow). */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setEditing((v) => !v)}
                disabled={saving}
                aria-pressed={editing}
                className={editing ? BTN_PRIMARY : BTN_NEUTRAL}
              >
                {editing
                  ? t('uiLibrary.motionZones.doneEditing', 'Done editing')
                  : t('uiLibrary.motionZones.editGrid', 'Edit grid')}
              </button>
              <button
                type="button"
                onClick={() => setAll(true)}
                disabled={saving}
                className={BTN_NEUTRAL}
              >
                {t('uiLibrary.motionZones.allOn', 'All on')}
              </button>
              <button
                type="button"
                onClick={() => setAll(false)}
                disabled={saving}
                className={BTN_NEUTRAL}
              >
                {t('uiLibrary.motionZones.allOff', 'All off')}
              </button>
              <button type="button" onClick={invert} disabled={saving} className={BTN_NEUTRAL}>
                {t('uiLibrary.motionZones.invert', 'Invert')}
              </button>

              {/* Cell-size picker — bigger UI cells (coarser grid), expanded back
                   to the camera grid on save. ×1 = camera grid (finest / floor). */}
              <div
                className="flex items-center gap-1 ml-1"
                role="group"
                aria-label={t('uiLibrary.motionZones.cellSize', 'Cell size')}
              >
                <span className={`${TEXT_HINT} mr-0.5`}>
                  {t('uiLibrary.motionZones.cellSize', 'Cell size')}
                </span>
                {GRID_MULTIPLIERS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => changeMultiplier(m)}
                    disabled={saving}
                    aria-pressed={multiplier === m}
                    title={
                      m === 1
                        ? t(
                            'uiLibrary.motionZones.cameraGrid',
                            'Camera grid {{width}}×{{height}} (finest)',
                            {
                              width: cw,
                              height: ch,
                            },
                          )
                        : t(
                            'uiLibrary.motionZones.paintingGrid',
                            '{{width}}×{{height}} painting grid · cells ×{{factor}} bigger',
                            { width: coarseDim(cw, m), height: coarseDim(ch, m), factor: m },
                          )
                    }
                    className={multiplier === m ? BTN_PRIMARY : BTN_NEUTRAL}
                  >
                    ×{m}
                  </button>
                ))}
              </div>

              <span className={`${TEXT_HINT} ml-1 tabular-nums`}>
                {t(
                  'uiLibrary.motionZones.cells',
                  '{{active}} / {{total}} cells · {{width}}×{{height}}',
                  {
                    active: activeCount,
                    total: cameraTotal,
                    width: options.grid.width,
                    height: options.grid.height,
                  },
                )}
                {multiplier !== 1
                  ? t('uiLibrary.motionZones.paintSuffix', ' · paint {{width}}×{{height}}', {
                      width: uiWidth,
                      height: uiHeight,
                    })
                  : ''}
              </span>

              <span className="flex-1" />

              <button
                type="button"
                onClick={revert}
                disabled={saving || !dirty}
                className="rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-foreground-subtle hover:bg-surface-hover disabled:opacity-40 transition-colors"
              >
                {t('uiLibrary.motionZones.revert', 'Revert')}
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !dirty}
                className={BTN_PRIMARY}
              >
                {saving
                  ? t('uiLibrary.motionZones.saving', 'Saving…')
                  : t('uiLibrary.motionZones.save', 'Save')}
              </button>
            </div>
          </>
        )}
      </div>
    </WidgetPanel>
  )
}
