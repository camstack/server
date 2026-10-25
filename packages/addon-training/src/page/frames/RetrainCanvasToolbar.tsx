/**
 * The canvas toolbar: zoom, the pan tool, undo / redo, and the keyboard map.
 *
 * Every control here has a key (`lib/retrain-shortcuts.ts`); the buttons
 * exist for touch, where there is no keyboard, and so the keys can be
 * discovered. The zoom state lives in {@link useRetrainViewport} so the page,
 * the toolbar, the canvas and the keyboard all move one viewport.
 */
import { Button, Popover, PopoverContent, PopoverTrigger } from '@camstack/ui-library'
import {
  ChevronLeft,
  ChevronRight,
  Hand,
  Keyboard,
  Maximize,
  Redo2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useCallback, useState } from 'react'
import { useT } from '../../i18n/index.js'
import type { NormBox } from './lib/retrain-boxes.js'
import { RETRAIN_SHORTCUTS } from './lib/retrain-shortcuts.js'
import { FULL_VIEWPORT, viewportCentre, ZOOM_STEP, zoomAt, zoomLevel } from './lib/retrain-zoom.js'

export interface RetrainViewport {
  readonly viewport: NormBox
  readonly setViewport: (viewport: NormBox) => void
  readonly zoomIn: () => void
  readonly zoomOut: () => void
  readonly fit: () => void
  readonly panMode: boolean
  readonly togglePan: () => void
}

export function useRetrainViewport(): RetrainViewport {
  const [viewport, setViewport] = useState<NormBox>(FULL_VIEWPORT)
  const [panMode, setPanMode] = useState(false)
  const zoomIn = useCallback(() => {
    setViewport((vp) => zoomAt(vp, viewportCentre(vp), ZOOM_STEP))
  }, [])
  const zoomOut = useCallback(() => {
    setViewport((vp) => zoomAt(vp, viewportCentre(vp), 1 / ZOOM_STEP))
  }, [])
  const fit = useCallback(() => {
    setViewport(FULL_VIEWPORT)
  }, [])
  const togglePan = useCallback(() => {
    setPanMode((on) => !on)
  }, [])
  return { viewport, setViewport, zoomIn, zoomOut, fit, panMode, togglePan }
}

/** ← / → between frames of the corpus (across pages). */
export interface FrameNav {
  /** "3 of 120" — where the open frame is in the whole filtered corpus. */
  readonly label: string
  readonly canPrev: boolean
  readonly canNext: boolean
  readonly onPrev: () => void
  readonly onNext: () => void
}

interface RetrainCanvasToolbarProps {
  readonly frameNav?: FrameNav
  readonly view: RetrainViewport
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly onUndo: () => void
  readonly onRedo: () => void
}

export function RetrainCanvasToolbar({
  frameNav,
  view,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: RetrainCanvasToolbarProps) {
  const { t } = useT()
  const level = zoomLevel(view.viewport)
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 px-2 py-1 border-b border-border bg-surface">
      {frameNav !== undefined && (
        <>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('toolbar.previousFrame')}
            disabled={!frameNav.canPrev}
            onClick={frameNav.onPrev}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span
            data-testid="retrain-frame-position"
            className="min-w-14 text-center text-[11px] tabular-nums text-foreground-muted"
          >
            {frameNav.label}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('toolbar.nextFrame')}
            disabled={!frameNav.canNext}
            onClick={frameNav.onNext}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        </>
      )}
      <Button variant="ghost" size="sm" aria-label={t('toolbar.zoomOut')} onClick={view.zoomOut}>
        <ZoomOut className="h-3.5 w-3.5" />
      </Button>
      <span className="hidden w-12 text-center text-[11px] tabular-nums text-foreground-subtle sm:inline">
        {Math.round(level * 100)}%
      </span>
      <Button variant="ghost" size="sm" aria-label={t('toolbar.zoomIn')} onClick={view.zoomIn}>
        <ZoomIn className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('toolbar.fit')}
        disabled={level <= 1}
        onClick={view.fit}
      >
        <Maximize className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant={view.panMode ? 'secondary' : 'ghost'}
        size="sm"
        aria-label={t('toolbar.pan')}
        aria-pressed={view.panMode}
        onClick={view.togglePan}
      >
        <Hand className="h-3.5 w-3.5" />
      </Button>
      <span className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('toolbar.undo')}
        disabled={!canUndo}
        onClick={onUndo}
      >
        <Undo2 className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('toolbar.redo')}
        disabled={!canRedo}
        onClick={onRedo}
      >
        <Redo2 className="h-3.5 w-3.5" />
      </Button>
      <Popover>
        <PopoverTrigger
          aria-label={t('toolbar.shortcuts')}
          className="hidden h-7 items-center rounded-md px-2 text-foreground-subtle hover:bg-surface-hover hover:text-foreground sm:inline-flex"
        >
          <Keyboard className="h-3.5 w-3.5" />
        </PopoverTrigger>
        <PopoverContent className="w-80">
          <h3 className="mb-2 text-xs font-semibold text-foreground">
            {t('toolbar.shortcutsTitle')}
          </h3>
          <table className="w-full text-[11px]">
            <tbody>
              {RETRAIN_SHORTCUTS.map((id) => (
                <tr key={id} className="align-top">
                  <td className="py-0.5 pr-2 font-mono whitespace-nowrap text-foreground">
                    {t(`shortcuts.${id}.keys`)}
                  </td>
                  <td className="py-0.5 text-foreground-subtle">{t(`shortcuts.${id}.does`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PopoverContent>
      </Popover>
    </div>
  )
}
