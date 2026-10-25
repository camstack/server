/**
 * PTZOverlay — pan / tilt / zoom controls.
 *
 * Two visual variants driven by `mode`:
 *   - `'overlay'` (default): translucent dark pill positioned bottom-
 *     right of the camera viewport. Used as `extraOverlay` on the
 *     `CameraStreamPlayer` so operators can drive PTZ without leaving
 *     the live view. Opaque background + subtle ring keeps the d-pad
 *     legible against any frame.
 *   - `'panel'`: full-bleed inside a host container (e.g. the floating
 *     PTZ panel in DeviceDetail). No absolute positioning, no inner
 *     wrapper card — the host's chrome is the only frame. Inherits the
 *     surrounding `bg-surface` so the dark theme reads consistently
 *     instead of the previous always-dark-bubble look.
 *
 * Interaction model is identical across modes: short tap fires a
 * discrete pulse (`move`); long press starts continuous motion until
 * release (`startContinuous` + `stopContinuous` on pointer up).
 */
import { useUiText } from '../contexts/ui-text'
import {
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Home,
  ZoomIn,
  ZoomOut,
  ChevronDown,
  Crosshair,
  Plus,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { PTZDirection, UsePTZResult } from '../hooks/use-ptz'
import { useConfirm } from './confirm-dialog'
import { cn } from '../lib/cn'

interface DPadButtonProps {
  readonly direction: PTZDirection
  readonly icon: LucideIcon
  readonly disabled?: boolean
  readonly className?: string
  readonly variant: 'overlay' | 'panel'
  readonly onMove: (d: PTZDirection) => void
  readonly onStart: (d: PTZDirection) => void
  readonly onStop: () => void
}

function DPadButton({
  direction,
  icon: Icon,
  disabled,
  className,
  variant,
  onMove,
  onStart,
  onStop,
}: DPadButtonProps) {
  const [pressedAt, setPressedAt] = useState<number | null>(null)
  const [continuous, setContinuous] = useState(false)

  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      if (disabled) return
      e.currentTarget.setPointerCapture(e.pointerId)
      setPressedAt(Date.now())
      setContinuous(false)
      const timer = setTimeout(() => {
        setContinuous(true)
        onStart(direction)
      }, 250)
      e.currentTarget.dataset.timer = String(timer)
    },
    [direction, disabled, onStart],
  )

  const handlePointerUp = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      const timerId = Number(e.currentTarget.dataset.timer)
      if (timerId) clearTimeout(timerId)
      e.currentTarget.dataset.timer = ''
      if (continuous) {
        onStop()
      } else if (pressedAt !== null) {
        onMove(direction)
      }
      setPressedAt(null)
      setContinuous(false)
    },
    [continuous, direction, onMove, onStop, pressedAt],
  )

  const handlePointerCancel = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      const timerId = Number(e.currentTarget.dataset.timer)
      if (timerId) clearTimeout(timerId)
      e.currentTarget.dataset.timer = ''
      if (continuous) onStop()
      setPressedAt(null)
      setContinuous(false)
    },
    [continuous, onStop],
  )

  // Larger hit area in panel mode where layout space is generous;
  // overlay stays compact to keep the viewport readable.
  const sizeClass = variant === 'panel' ? 'h-9 w-9' : 'h-7 w-7'
  const iconSizeClass = variant === 'panel' ? 'h-4 w-4' : 'h-3.5 w-3.5'

  // Overlay mode pill is forced-dark (zinc-900/90) regardless of the
  // app theme, so icons must be light-on-dark explicitly — using
  // `text-foreground` would render them invisible under a light theme.
  const baseClass =
    variant === 'panel'
      ? 'text-foreground hover:bg-surface-hover active:bg-surface-hover/80'
      : 'text-white hover:bg-white/15 active:bg-white/25'

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      className={cn(
        'flex items-center justify-center rounded transition-colors disabled:opacity-40',
        baseClass,
        sizeClass,
        className,
      )}
      title={direction}
    >
      <Icon className={iconSizeClass} />
    </button>
  )
}

export interface PTZOverlayProps {
  /** Result of `usePTZ(trpc, deviceId)`. */
  readonly controls: UsePTZResult
  /**
   * Visual variant. `'overlay'` floats over the camera viewport with
   * a translucent dark pill; `'panel'` lays out flat inside its
   * container with no inner chrome — use that when hosting inside a
   * floating panel that already provides the dark surface.
   */
  readonly mode?: 'overlay' | 'panel'
  /** Show the presets dropdown (default: true when presets > 0). */
  readonly showPresets?: boolean
  /** Show the zoom buttons (default: true). */
  readonly showZoom?: boolean
  /** Show the home button (default: true). */
  readonly showHome?: boolean
  readonly className?: string
}

export function PTZOverlay({
  controls,
  mode = 'overlay',
  showPresets,
  showZoom = true,
  showHome = true,
  className,
}: PTZOverlayProps): JSX.Element {
  const t = useUiText()
  const {
    move,
    startContinuous,
    stopContinuous,
    zoom,
    goHome,
    homePreset,
    goToPreset,
    savePreset,
    updatePreset,
    deletePreset,
    presets,
    options,
    busy,
    error,
  } = controls
  const confirm = useConfirm()
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [presetName, setPresetName] = useState('')
  // The presets menu is rendered in a fixed-position PORTAL anchored to the
  // trigger button. An in-flow/absolute menu is clipped by the tabbed device
  // panel's `overflow-hidden` ancestor (it can't float outside the box); a
  // body-level fixed layer escapes that clip entirely.
  const presetTriggerRef = useRef<HTMLButtonElement>(null)
  const presetMenuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null)

  const isPanel = mode === 'panel'

  // Zoom controls only when the camera actually advertises zoom via
  // `getOptions().hasZoom` (a fixed-lens turret reports `false`). Default
  // to visible when options haven't loaded yet, so a slow probe doesn't
  // flash the buttons away on a camera that does have zoom.
  const zoomVisible = showZoom && (options?.hasZoom ?? true)

  // The presets popover is available whenever the camera SUPPORTS presets —
  // not only once one exists — so the first preset can be created. Falls
  // back to `presets.length > 0` when options haven't loaded.
  const supportsPresets = options?.supportsPresets ?? presets.length > 0
  const presetsVisible = (showPresets ?? supportsPresets) && supportsPresets

  // Preset save/delete is an admin-only, destructive surface — keep it
  // out of the floating camera-viewport overlay and only render it in
  // the dedicated `panel` mode, gated on the camera advertising preset
  // support via `getOptions`.
  const presetManagementVisible = isPanel && (options?.supportsPresets ?? false)

  // Disable "Save" once the camera's known preset budget is exhausted.
  const maxPresetsReached =
    options?.maxPresets !== undefined && presets.length >= options.maxPresets

  const handleSavePreset = useCallback(async () => {
    const name = presetName.trim()
    if (!name || busy || maxPresetsReached) return
    const created = await savePreset(name)
    if (created !== undefined) setPresetName('')
  }, [presetName, busy, maxPresetsReached, savePreset])

  const handleDeletePreset = useCallback(
    async (presetId: string, label: string) => {
      const ok = await confirm({
        title: t('uiLibrary.ptzOverlay.deleteTitle', 'Delete preset'),
        message: t(
          'uiLibrary.ptzOverlay.deleteMessage',
          'Delete PTZ preset "{{label}}"? This removes it from the camera.',
          { label },
        ),
        confirmLabel: t('uiLibrary.ptzOverlay.delete', 'Delete'),
        variant: 'danger',
      })
      if (!ok) return
      await deletePreset(presetId)
    },
    [confirm, deletePreset, t],
  )

  const handleUpdatePreset = useCallback(
    async (presetId: string, label: string) => {
      const ok = await confirm({
        title: t('uiLibrary.ptzOverlay.updateTitle', 'Update preset'),
        message: t(
          'uiLibrary.ptzOverlay.updateMessage',
          'Overwrite preset "{{label}}" with the camera\'s current position?',
          { label },
        ),
        confirmLabel: t('uiLibrary.ptzOverlay.update', 'Update'),
      })
      if (!ok) return
      await updatePreset(presetId)
    },
    [confirm, updatePreset, t],
  )

  // Anchor the portalled menu under the trigger, right-aligned. Recompute on
  // open and on scroll/resize so it tracks the trigger; close on outside click.
  useLayoutEffect(() => {
    if (!presetsOpen) {
      setMenuPos(null)
      return
    }
    const reposition = () => {
      const rect = presetTriggerRef.current?.getBoundingClientRect()
      if (rect) setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [presetsOpen])

  useEffect(() => {
    if (!presetsOpen) return
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (presetMenuRef.current?.contains(target) || presetTriggerRef.current?.contains(target)) {
        return
      }
      setPresetsOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPresetsOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [presetsOpen])

  // Outer container — overlay floats with absolute positioning,
  // panel mode flows naturally inside its host (no fixed offsets).
  // Top-right corner keeps the d-pad clear of the bottom area where
  // detection bounding boxes / motion zones / status badges land.
  const containerClass = isPanel
    ? 'flex flex-col items-stretch gap-2 w-full h-full p-3'
    : 'pointer-events-auto absolute top-3 right-3 z-10 flex flex-col items-end gap-2'

  // Inner row chrome — overlay needs its own pill (background, border)
  // because the camera viewport is BEHIND it. We need enough opacity
  // for the controls to read against ANY frame (a black-scene camera
  // would swallow a translucent pill, "dark on dark"). zinc-900/90
  // + a brighter border + a soft shadow gives strong contrast on
  // both bright and dark frames; backdrop-blur smooths the boundary.
  // Panel mode inherits the host's surface and just adds spacing.
  const rowClass = isPanel
    ? cn('flex items-center gap-3 rounded-lg p-2', busy && 'ring-1 ring-primary/40')
    : cn(
        'flex items-center gap-2 rounded-lg border border-white/30 bg-zinc-900/90 backdrop-blur-md p-2 shadow-lg shadow-black/40',
        busy && 'ring-1 ring-primary/40',
      )

  // Side column buttons (zoom, home) match the d-pad's button styling.
  const sideButtonSize = isPanel ? 'h-9 w-9' : 'h-7 w-7'
  const sideIconSize = isPanel ? 'h-4 w-4' : 'h-3.5 w-3.5'
  const sideButtonHover = isPanel
    ? 'text-foreground hover:bg-surface-hover'
    : 'text-white hover:bg-white/15'

  // Vertical separator between d-pad and side controls — uses a darker
  // divider in panel mode to read against the host surface, white-tint
  // in overlay mode against the video background.
  const sepClass = isPanel ? 'h-12 w-px bg-border mx-1' : 'h-12 w-px bg-white/15 mx-1'

  return (
    <div className={cn(containerClass, className)}>
      {error && (
        <div className="rounded bg-danger/90 px-2 py-1 text-[10px] font-medium text-white shadow-lg max-w-[200px] self-center">
          {t('uiLibrary.ptzOverlay.error', 'PTZ: {{error}}', { error })}
        </div>
      )}

      <div className={cn(rowClass, isPanel && 'justify-center')}>
        {/* 4-direction cross — Reolink Baichuan PTZ only accepts
            discrete `Left`/`Right`/`Up`/`Down` commands. Diagonal
            inputs translated to two sequential commands which the
            camera serialised, producing horizontal-only or
            vertical-only motion (not real diagonal). The corner
            slots are kept blank for layout symmetry; if the lib
            ever exposes a true diagonal pulse we can wire them. */}
        <div className="grid grid-cols-3 gap-0.5">
          <span aria-hidden className={isPanel ? 'h-9 w-9' : 'h-7 w-7'} />
          <DPadButton
            direction="up"
            icon={ArrowUp}
            variant={mode}
            onMove={move}
            onStart={startContinuous}
            onStop={stopContinuous}
          />
          <span aria-hidden className={isPanel ? 'h-9 w-9' : 'h-7 w-7'} />
          <DPadButton
            direction="left"
            icon={ArrowLeft}
            variant={mode}
            onMove={move}
            onStart={startContinuous}
            onStop={stopContinuous}
          />
          <span aria-hidden className={isPanel ? 'h-9 w-9' : 'h-7 w-7'} />
          <DPadButton
            direction="right"
            icon={ArrowRight}
            variant={mode}
            onMove={move}
            onStart={startContinuous}
            onStop={stopContinuous}
          />
          <span aria-hidden className={isPanel ? 'h-9 w-9' : 'h-7 w-7'} />
          <DPadButton
            direction="down"
            icon={ArrowDown}
            variant={mode}
            onMove={move}
            onStart={startContinuous}
            onStop={stopContinuous}
          />
          <span aria-hidden className={isPanel ? 'h-9 w-9' : 'h-7 w-7'} />
        </div>

        {(zoomVisible || showHome) && <div className={sepClass} />}

        <div className="flex flex-col gap-0.5">
          {zoomVisible && (
            <>
              <button
                type="button"
                onClick={() => zoom('in')}
                disabled={busy}
                title={t('uiLibrary.ptzOverlay.zoomIn', 'Zoom in')}
                className={cn(
                  'flex items-center justify-center rounded disabled:opacity-40',
                  sideButtonSize,
                  sideButtonHover,
                )}
              >
                <ZoomIn className={sideIconSize} />
              </button>
              <button
                type="button"
                onClick={() => zoom('out')}
                disabled={busy}
                title={t('uiLibrary.ptzOverlay.zoomOut', 'Zoom out')}
                className={cn(
                  'flex items-center justify-center rounded disabled:opacity-40',
                  sideButtonSize,
                  sideButtonHover,
                )}
              >
                <ZoomOut className={sideIconSize} />
              </button>
            </>
          )}
          {showHome && (
            <button
              type="button"
              onClick={() => goHome()}
              /* `goHome` now REFUSES when no home preset is configured, instead
                 of quietly going to whatever sat in slot 0 or 1. A refusal the
                 operator cannot see is the same silent no-op in a new place, so
                 the button says it is unavailable and why — a disabled feature
                 must never look like a broken one (D62). `homePreset === null`
                 is still loading and must not read as "not configured". */
              disabled={busy || homePreset?.source === 'none'}
              title={
                homePreset?.source === 'none'
                  ? t(
                      'uiLibrary.ptzOverlay.noHome',
                      'No home preset set for this camera — pick one in PTZ settings',
                    )
                  : t('uiLibrary.ptzOverlay.goHome', 'Go home')
              }
              className={cn(
                'flex items-center justify-center rounded disabled:opacity-40',
                sideButtonSize,
                sideButtonHover,
              )}
            >
              <Home className={sideIconSize} />
            </button>
          )}
        </div>

        {presetsVisible && (
          <div className="relative">
            <button
              ref={presetTriggerRef}
              type="button"
              onClick={() => setPresetsOpen((v) => !v)}
              disabled={busy}
              className={cn(
                'flex items-center gap-1 rounded px-2 text-[10px] disabled:opacity-40',
                isPanel
                  ? 'h-9 text-foreground hover:bg-surface-hover'
                  : 'h-7 text-white hover:bg-white/15',
              )}
              title={t('uiLibrary.ptzOverlay.presets', 'Presets')}
            >
              {t('uiLibrary.ptzOverlay.presets', 'Presets')}
              <ChevronDown
                className={cn('h-3 w-3 transition-transform', presetsOpen && 'rotate-180')}
              />
            </button>
            {presetsOpen &&
              menuPos &&
              createPortal(
                <div
                  ref={presetMenuRef}
                  style={{ position: 'fixed', top: menuPos.top, right: menuPos.right, zIndex: 60 }}
                  className={cn(
                    // Body-level fixed layer — escapes the device panel's
                    // `overflow-hidden` clip that squeezed the old in-panel
                    // menu. Anchored under the trigger, right-aligned; opens
                    // downward. Wider when it also hosts the save form.
                    'rounded-lg shadow-xl py-1',
                    presetManagementVisible ? 'min-w-[220px]' : 'min-w-[140px]',
                    isPanel
                      ? 'bg-surface border border-border'
                      : 'border border-white/30 bg-zinc-900/95 backdrop-blur-md',
                  )}
                >
                  {presets.length === 0 && (
                    <div
                      className={cn(
                        'px-3 py-1.5 text-[10px]',
                        isPanel ? 'text-foreground-subtle' : 'text-white/60',
                      )}
                    >
                      {t('uiLibrary.ptzOverlay.noPresets', 'No presets yet')}
                    </div>
                  )}
                  {presets.map((p) => (
                    <div
                      key={p.id}
                      className={cn(
                        'group flex items-center',
                        isPanel ? 'hover:bg-surface-hover' : 'hover:bg-white/15',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          void goToPreset(p.id)
                          setPresetsOpen(false)
                        }}
                        disabled={busy}
                        className={cn(
                          'flex-1 px-3 py-1.5 text-left text-[10px] disabled:opacity-40',
                          isPanel ? 'text-foreground' : 'text-white',
                        )}
                      >
                        {p.name || p.id}
                      </button>
                      {/* A reserved id is a firmware FUNCTION sharing the preset
                          namespace -- "Back to origin", "Remote reboot", "Call
                          OSD menu". Going TO one is fine and stays available
                          above; overwriting one is what answered HTTP 500, so
                          the two write affordances are withheld. */}
                      {presetManagementVisible && p.writable && (
                        <>
                          <button
                            type="button"
                            onClick={() => void handleUpdatePreset(p.id, p.name || p.id)}
                            disabled={busy}
                            title={t(
                              'uiLibrary.ptzOverlay.overwriteTitle',
                              'Overwrite "{{name}}" with current position',
                              { name: p.name || p.id },
                            )}
                            className={cn(
                              'flex h-5 w-5 shrink-0 items-center justify-center rounded',
                              'text-foreground-subtle hover:bg-primary/15 hover:text-primary disabled:opacity-40',
                            )}
                          >
                            <Crosshair className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeletePreset(p.id, p.name || p.id)}
                            disabled={busy}
                            title={t(
                              'uiLibrary.ptzOverlay.deletePreset',
                              'Delete preset {{name}}',
                              {
                                name: p.name || p.id,
                              },
                            )}
                            className={cn(
                              'mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded',
                              'text-foreground-subtle hover:bg-danger/15 hover:text-danger disabled:opacity-40',
                            )}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                  {/* Create-preset form lives INSIDE the popover so it needs no
                    layout space until opened and works from the very first
                    preset (admin + `supportsPresets` gated). */}
                  {presetManagementVisible && (
                    <>
                      {presets.length > 0 && (
                        <div className={cn('my-1 h-px', isPanel ? 'bg-border' : 'bg-white/15')} />
                      )}
                      <div className="flex items-center gap-1 px-2 py-1">
                        <input
                          type="text"
                          value={presetName}
                          onChange={(e) => setPresetName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleSavePreset()
                          }}
                          disabled={busy || maxPresetsReached}
                          placeholder={t('uiLibrary.ptzOverlay.newPreset', 'New preset name')}
                          maxLength={64}
                          className={cn(
                            'min-w-0 flex-1 rounded border px-2 py-1 text-[11px]',
                            'focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-40',
                            isPanel
                              ? 'border-border bg-surface text-foreground placeholder:text-foreground-subtle'
                              : 'border-white/30 bg-zinc-800 text-white placeholder:text-white/40',
                          )}
                        />
                        <button
                          type="button"
                          onClick={() => void handleSavePreset()}
                          disabled={busy || maxPresetsReached || presetName.trim().length === 0}
                          title={
                            maxPresetsReached
                              ? t(
                                  'uiLibrary.ptzOverlay.limitTitle',
                                  'Camera preset limit reached ({{max}})',
                                  { max: options?.maxPresets },
                                )
                              : t(
                                  'uiLibrary.ptzOverlay.saveTitle',
                                  'Save current position as a new preset',
                                )
                          }
                          className={cn(
                            'flex h-7 w-7 shrink-0 items-center justify-center rounded',
                            'bg-primary/15 text-primary hover:bg-primary/25 disabled:opacity-40',
                          )}
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {maxPresetsReached && (
                        <span
                          className={cn(
                            'block px-2 pb-1 text-[10px]',
                            isPanel ? 'text-foreground-subtle' : 'text-white/60',
                          )}
                        >
                          {t('uiLibrary.ptzOverlay.limit', 'Preset limit reached ({{max}}).', {
                            max: options?.maxPresets,
                          })}
                        </span>
                      )}
                    </>
                  )}
                </div>,
                document.body,
              )}
          </div>
        )}
      </div>
    </div>
  )
}
