import type { ReactNode } from 'react'
import { ChevronUp, ChevronDown, Square } from 'lucide-react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { cn } from '../../lib/cn'
import { useUiText } from '../../contexts/ui-text'
import type { ControlPanelProps } from './types'

export function CoverPanel({ trpc, deviceId, features, layout }: ControlPanelProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.cover,
    slice: (d) => d.state.cover,
  })
  // Gate on the slice/availability, NOT just `cap` (the proxy facade is always
  // present). A device without the cover cap bound has no slice → render nothing.
  if (slice === undefined) return null

  const positionable = (features ?? []).includes('cover-positionable')
  const busy = !available
  const position = slice.position

  const press = (fn?: (input: Record<string, never>) => Promise<void>): void => {
    if (busy || !fn) return
    void fn({})
  }

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1',
        layout === 'full' && 'flex-col items-stretch gap-2',
      )}
    >
      <div className="inline-flex items-center gap-1">
        <CoverButton
          label={t('uiLibrary.coverPanel.open', 'Open')}
          busy={busy}
          onClick={() => press(cap?.open)}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </CoverButton>
        <CoverButton
          label={t('uiLibrary.coverPanel.stop', 'Stop')}
          busy={busy}
          onClick={() => press(cap?.stop)}
        >
          <Square className="h-3 w-3" />
        </CoverButton>
        <CoverButton
          label={t('uiLibrary.coverPanel.close', 'Close')}
          busy={busy}
          onClick={() => press(cap?.close)}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </CoverButton>
      </div>
      {positionable && layout === 'full' && (
        <label className="flex items-center gap-2 text-xs text-foreground-subtle">
          <span>{t('uiLibrary.coverPanel.position', 'Position')}</span>
          <input
            aria-label={t('uiLibrary.coverPanel.position', 'Position')}
            type="range"
            min={0}
            max={100}
            step={1}
            value={position ?? 0}
            disabled={busy}
            onChange={(e) => {
              if (!busy) void cap?.setPosition({ position: Number(e.target.value) })
            }}
          />
          <span className="tabular-nums w-8 text-right">{position ?? '—'}%</span>
        </label>
      )}
    </div>
  )
}

interface CoverButtonProps {
  readonly label: string
  readonly busy: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}
function CoverButton({ label, busy, onClick, children }: CoverButtonProps): ReactNode {
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
        busy && 'opacity-40 cursor-not-allowed',
      )}
    >
      {children}
    </button>
  )
}
