import { useUiText } from '../../contexts/ui-text'
import type { ReactNode } from 'react'
import { ChevronUp, ChevronDown, Square } from 'lucide-react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import type { CoverStatus, CoverState } from '@camstack/types'
import type { DeviceControlProps } from './control-registry'

/** Button highlight variant for cover state-aware colouring. */
export type CoverHighlightVariant = 'accent' | 'filled' | 'neutral'

export interface CoverButtonHighlight {
  readonly up: CoverHighlightVariant
  readonly stop: CoverHighlightVariant
  readonly down: CoverHighlightVariant
}

/**
 * Pure helper — maps a live CoverState (or undefined when no slice yet)
 * to per-button highlight variants.
 *
 *   opening → up:accent  (transient/active upward motion)
 *   closing → down:accent (transient/active downward motion)
 *   open    → up:filled   (stable fully-open state)
 *   closed  → down:filled (stable fully-closed state)
 *   stopped / undefined → neutral (no active state)
 */
export function coverHighlight(state: CoverState | undefined): CoverButtonHighlight {
  switch (state) {
    case 'opening':
      return { up: 'accent', stop: 'neutral', down: 'neutral' }
    case 'closing':
      return { up: 'neutral', stop: 'neutral', down: 'accent' }
    case 'open':
      return { up: 'filled', stop: 'neutral', down: 'neutral' }
    case 'closed':
      return { up: 'neutral', stop: 'neutral', down: 'filled' }
    default:
      return { up: 'neutral', stop: 'neutral', down: 'neutral' }
  }
}

/**
 * Map a highlight variant to real design-token Tailwind classes.
 * Tokens sourced from button.tsx (primary variant) and stream-panel.tsx
 * active-state patterns used across the project.
 *   accent  → bg-primary text-primary-foreground  (transient motion, clearly lit)
 *   filled  → bg-primary/15 text-primary           (stable open/closed, subtler)
 *   neutral → '' (default button colours apply)
 */
function highlightClass(variant: CoverHighlightVariant): string {
  switch (variant) {
    case 'accent':
      return 'bg-primary text-primary-foreground'
    case 'filled':
      return 'bg-primary/15 text-primary'
    case 'neutral':
      return ''
  }
}

interface CoverCtrlButtonProps {
  readonly label: string
  readonly busy: boolean
  readonly variant: CoverHighlightVariant
  readonly onClick: () => void
  readonly children: ReactNode
}

function CoverCtrlButton({
  label,
  busy,
  variant,
  onClick,
  children,
}: CoverCtrlButtonProps): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        'inline-flex h-5 w-5 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors',
        highlightClass(variant),
        busy && 'opacity-40 cursor-not-allowed',
      )}
    >
      {children}
    </button>
  )
}

/**
 * CoverInlineControl — compact, state-aware cover controls for a
 * device-list row. Renders ↑ ■ ↓ buttons + optional % open badge.
 * Reuses `useDeviceCapability` exactly as `CoverPanel` does.
 */
export function CoverInlineControl({ trpc, deviceId, optimistic }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability<
    {
      open: (i: Record<string, never>) => Promise<void>
      close: (i: Record<string, never>) => Promise<void>
      stop: (i: Record<string, never>) => Promise<void>
      setPosition: (i: { position: number }) => Promise<void>
    },
    CoverStatus
  >({
    trpc,
    deviceId,
    cap: (d) =>
      d.cover as
        | {
            open: (i: Record<string, never>) => Promise<void>
            close: (i: Record<string, never>) => Promise<void>
            stop: (i: Record<string, never>) => Promise<void>
            setPosition: (i: { position: number }) => Promise<void>
          }
        | undefined,
    slice: (d) => d.state.cover,
  })

  const { display, applyOptimistic } = useOptimisticSlice<CoverStatus>(slice, {
    enabled: optimistic ?? true,
  })

  // Only hide the control entirely when the device has no cover cap at all.
  // A transient undefined slice (state refetch / mid-transition re-render) must NOT
  // remove the buttons — that causes the control to flash away during operations.
  if (cap === undefined) return null

  // Treat an undefined display as "unknown" state → neutral highlight, buttons clickable.
  const hl = coverHighlight(display?.state)

  // busy = true only when the server signals the proxy is unavailable.
  // A normal in-flight operation does NOT make buttons disappear —
  // they stay visible and their active-state highlight remains shown.
  const busy = !available

  const press = (
    fn?: (input: Record<string, never>) => Promise<void>,
    patch?: Partial<CoverStatus>,
  ): void => {
    if (busy || !fn) return
    if (patch !== undefined) applyOptimistic(patch)
    void fn({})
  }

  return (
    <div className="inline-flex items-center gap-1">
      <CoverCtrlButton
        label={t('uiLibrary.coverInline.open', 'Open')}
        busy={busy}
        variant={hl.up}
        onClick={() => press(cap?.open, { state: 'opening' })}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </CoverCtrlButton>
      <CoverCtrlButton
        label={t('uiLibrary.coverInline.stop', 'Stop')}
        busy={busy}
        variant={hl.stop}
        onClick={() => press(cap?.stop, { state: 'stopped' })}
      >
        <Square className="h-3 w-3" />
      </CoverCtrlButton>
      <CoverCtrlButton
        label={t('uiLibrary.coverInline.close', 'Close')}
        busy={busy}
        variant={hl.down}
        onClick={() => press(cap?.close, { state: 'closing' })}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </CoverCtrlButton>
      {display !== undefined && display.position !== null && (
        <span className="tabular-nums text-xs text-foreground-subtle ml-1">
          {display.position}%
        </span>
      )}
    </div>
  )
}
