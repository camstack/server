import { useRef, useState, useCallback, useEffect, type ReactNode, type JSX } from 'react'
import { X, Minimize2, Maximize2, GripHorizontal, type LucideIcon } from 'lucide-react'
import { cn } from '../lib/cn'
import { useIsMobile } from '../hooks/use-is-mobile'
import { useUiText } from '../contexts/ui-text'

export interface FloatingPanelPosition {
  readonly x: number
  readonly y: number
}

export interface FloatingPanelSize {
  readonly w: number
  readonly h: number
}

export interface FloatingPanelProps {
  /** Panel title displayed in the title bar */
  title: string
  /** Optional icon shown before the title */
  icon?: LucideIcon
  /**
   * Controlled position. When set, the owner holds the position (so it can
   * survive the panel being unmounted on close) and receives every drag step
   * through `onPositionChange`. Leave unset for an uncontrolled panel.
   */
  position?: FloatingPanelPosition
  onPositionChange?: (position: FloatingPanelPosition) => void
  /** Controlled size, same contract as `position` (resize via the corner handle). */
  size?: FloatingPanelSize
  onSizeChange?: (size: FloatingPanelSize) => void
  /** Called when the close button is clicked */
  onClose: () => void
  /** Panel content */
  children: ReactNode
  /** Default width in pixels */
  defaultWidth?: number
  /** Default height in pixels */
  defaultHeight?: number
  /** Minimum width in pixels */
  minWidth?: number
  /** Minimum height in pixels */
  minHeight?: number
  /** Offset index to stagger multiple panels (adds 30px offset per index) */
  offsetIndex?: number
  /** Additional CSS classes for the panel container */
  className?: string
}

export function FloatingPanel({
  title,
  icon: Icon,
  position,
  onPositionChange,
  size: controlledSize,
  onSizeChange,
  onClose,
  children,
  defaultWidth = 360,
  defaultHeight = 280,
  minWidth = 280,
  minHeight = 160,
  offsetIndex = 0,
  className,
}: FloatingPanelProps): JSX.Element {
  const t = useUiText()
  const [ownPos, setOwnPos] = useState<FloatingPanelPosition>({
    x: 80 + offsetIndex * 30,
    y: 80 + offsetIndex * 30,
  })
  const [ownSize, setOwnSize] = useState<FloatingPanelSize>({ w: defaultWidth, h: defaultHeight })
  const pos = position ?? ownPos
  const size = controlledSize ?? ownSize
  // The window-level listeners are registered once; they read the latest
  // size and callbacks through this ref instead of re-subscribing per move.
  const latest = useRef({ size, onPositionChange, onSizeChange })
  latest.current = { size, onPositionChange, onSizeChange }
  const [minimized, setMinimized] = useState(false)
  const dragging = useRef(false)
  const resizing = useRef(false)
  const offset = useRef({ x: 0, y: 0 })
  const isMobile = useIsMobile()

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragging.current = true
      offset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
    },
    [pos],
  )

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizing.current = true
    offset.current = { x: e.clientX, y: e.clientY }
  }, [])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (dragging.current) {
        const next = { x: e.clientX - offset.current.x, y: e.clientY - offset.current.y }
        setOwnPos(next)
        latest.current.onPositionChange?.(next)
      }
      if (resizing.current) {
        const dx = e.clientX - offset.current.x
        const dy = e.clientY - offset.current.y
        offset.current = { x: e.clientX, y: e.clientY }
        const prev = latest.current.size
        const next = { w: Math.max(minWidth, prev.w + dx), h: Math.max(minHeight, prev.h + dy) }
        // Keep the shared ref current so a second move before re-render adds up.
        latest.current = { ...latest.current, size: next }
        setOwnSize(next)
        latest.current.onSizeChange?.(next)
      }
    }
    const onMouseUp = () => {
      dragging.current = false
      resizing.current = false
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [minWidth, minHeight])

  if (isMobile) {
    return (
      <div
        className={cn(
          // Flush with the VIEWPORT bottom, which under `viewport-fit=cover`
          // is behind the iOS home indicator — so the inset is absorbed as
          // padding rather than an offset, keeping the edge flush while the
          // last row stays tappable. Collapses to 0 where there is no inset.
          'fixed inset-x-0 bottom-0 z-50 rounded-t-xl border-t border-border bg-background-elevated shadow-2xl flex flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]',
          className,
        )}
        style={{ maxHeight: '60dvh' }}
      >
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border shrink-0 bg-surface">
          <div className="flex items-center gap-2 min-w-0">
            {Icon && <Icon size={12} className="text-primary shrink-0" />}
            <span className="text-[11px] font-medium truncate">{title}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setMinimized(!minimized)}
              className="p-0.5 rounded hover:bg-surface-hover text-foreground-muted transition-colors"
            >
              {minimized ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
            </button>
            <button
              onClick={onClose}
              className="p-0.5 rounded hover:bg-danger/20 text-foreground-muted hover:text-danger transition-colors"
            >
              <X size={12} />
            </button>
          </div>
        </div>
        {!minimized && <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'fixed z-50 rounded-lg border border-border bg-background-elevated shadow-2xl flex flex-col overflow-hidden',
        className,
      )}
      style={{
        left: pos.x,
        top: pos.y,
        width: minimized ? 280 : size.w,
        height: minimized ? 'auto' : size.h,
      }}
    >
      {/* Title bar — draggable */}
      <div
        onMouseDown={onDragStart}
        className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border cursor-move select-none shrink-0 bg-surface"
      >
        <div className="flex items-center gap-2 min-w-0">
          <GripHorizontal size={12} className="text-foreground-subtle shrink-0" />
          {Icon && <Icon size={12} className="text-primary shrink-0" />}
          <span className="text-[11px] font-medium truncate">{title}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setMinimized(!minimized)}
            className="p-0.5 rounded hover:bg-surface-hover text-foreground-muted transition-colors"
            title={
              minimized
                ? t('uiLibrary.floatingPanel.restore', 'Restore')
                : t('uiLibrary.floatingPanel.minimize', 'Minimize')
            }
          >
            {minimized ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
          </button>
          <button
            onClick={onClose}
            className="p-0.5 rounded hover:bg-danger/20 text-foreground-muted hover:text-danger transition-colors"
            title={t('uiLibrary.floatingPanel.close', 'Close')}
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Content */}
      {!minimized && (
        <div className="flex-1 min-h-0 overflow-y-auto relative">
          {children}
          {/* Resize handle */}
          <div
            onMouseDown={onResizeStart}
            className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
            style={{
              background:
                'linear-gradient(135deg, transparent 50%, var(--color-foreground-subtle) 50%)',
              opacity: 0.4,
            }}
          />
        </div>
      )}
    </div>
  )
}
