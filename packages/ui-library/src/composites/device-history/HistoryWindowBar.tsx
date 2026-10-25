/**
 * The window controls on top of a History view: 24h | 7d | 30d | 1y | custom,
 * a custom from/to when picked, and "compare with previous period".
 */
import { type JSX } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { Checkbox } from '../../primitives/checkbox'
import { Input } from '../../primitives/input'
import { ChartWindowToggle } from '../charts/chart-window'
import type { CustomWindow, HistoryWindowId } from './history-window'

export interface HistoryWindowBarProps {
  readonly value: HistoryWindowId
  readonly onChange: (id: HistoryWindowId) => void
  readonly custom: CustomWindow | null
  readonly onCustomChange: (w: CustomWindow) => void
  /** Omit to hide the compare control. */
  readonly compare?: boolean
  readonly onCompareChange?: (on: boolean) => void
}

/** `datetime-local` value for an instant, in the browser's zone. */
function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromLocalInput(v: string): number | null {
  const ms = new Date(v).getTime()
  return Number.isFinite(ms) ? ms : null
}

export function HistoryWindowBar({
  value,
  onChange,
  custom,
  onCustomChange,
  compare,
  onCompareChange,
}: HistoryWindowBarProps): JSX.Element {
  const t = useUiText()
  const now = Date.now()
  const range = custom ?? { from: now - 86_400_000, to: now }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0">
      <ChartWindowToggle
        ariaLabel={t('uiLibrary.history.window', 'Time window')}
        value={value}
        onChange={onChange}
        options={[
          { id: '24h', label: t('uiLibrary.history.window24h', '24 h') },
          { id: '7d', label: t('uiLibrary.history.window7d', '7 d') },
          { id: '30d', label: t('uiLibrary.history.window30d', '30 d') },
          { id: '1y', label: t('uiLibrary.history.window1y', '1 y') },
          { id: 'custom', label: t('uiLibrary.history.windowCustom', 'Custom') },
        ]}
      />
      {value === 'custom' && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="datetime-local"
            aria-label={t('uiLibrary.history.from', 'From')}
            className="h-7 w-auto text-xs"
            value={toLocalInput(range.from)}
            onChange={(e) => {
              const from = fromLocalInput(e.target.value)
              if (from !== null && from < range.to) onCustomChange({ from, to: range.to })
            }}
          />
          <span className="text-[10px] text-foreground-subtle">–</span>
          <Input
            type="datetime-local"
            aria-label={t('uiLibrary.history.to', 'To')}
            className="h-7 w-auto text-xs"
            value={toLocalInput(range.to)}
            onChange={(e) => {
              const to = fromLocalInput(e.target.value)
              if (to !== null && to > range.from) onCustomChange({ from: range.from, to })
            }}
          />
        </div>
      )}
      {compare !== undefined && onCompareChange && (
        <label className="inline-flex items-center gap-1.5 text-[11px] text-foreground-muted cursor-pointer select-none">
          <Checkbox checked={compare} onChange={(e) => onCompareChange(e.target.checked)} />
          {t('uiLibrary.history.compare', 'Compare with previous period')}
        </label>
      )}
    </div>
  )
}
