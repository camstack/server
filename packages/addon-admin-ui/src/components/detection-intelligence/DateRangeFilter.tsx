/**
 * DateRangeFilter — preset chips (24h / 7d / 30d / All) plus an optional custom
 * from/to native date range. Emits a resolved `DateRange` (epoch-ms window);
 * the parent filters the fetched faces client-side.
 *
 * Local state owns the visible selection (which preset is lit, the two date
 * inputs); the parent only consumes the emitted range.
 */
import { useState } from 'react'
import {
  type DateRange,
  type DateRangePreset,
  presetToRange,
  dateInputToStartMs,
  dateInputToEndMs,
} from '../../lib/face-gallery-filters.js'
import { useTranslation } from 'react-i18next'

interface DateRangeFilterProps {
  readonly onChange: (next: DateRange) => void
}

type Selection = DateRangePreset | 'custom'

const PRESETS: readonly {
  readonly label?: string
  readonly labelKey?: string
  readonly value: DateRangePreset
}[] = [
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
  { labelKey: 'common.all', value: 'all' },
]

export function DateRangeFilter({ onChange }: DateRangeFilterProps) {
  const { t } = useTranslation()
  const [selection, setSelection] = useState<Selection>('all')
  const [fromStr, setFromStr] = useState('')
  const [toStr, setToStr] = useState('')

  function pickPreset(preset: DateRangePreset) {
    setSelection(preset)
    setFromStr('')
    setToStr('')
    onChange(presetToRange(preset, Date.now()))
  }

  function pickCustom(nextFrom: string, nextTo: string) {
    setSelection('custom')
    setFromStr(nextFrom)
    setToStr(nextTo)
    onChange({ fromMs: dateInputToStartMs(nextFrom), toMs: dateInputToEndMs(nextTo) })
  }

  const dateInputClass =
    'rounded-md border border-border bg-surface px-2 py-1.5 text-[11px] text-foreground outline-none focus:border-primary [color-scheme:light] dark:[color-scheme:dark]'

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
        {PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => pickPreset(p.value)}
            className={`rounded px-2.5 py-1 text-[11px] transition-colors ${
              selection === p.value
                ? 'bg-primary/12 text-primary font-medium'
                : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
            }`}
          >
            {p.labelKey !== undefined ? t(p.labelKey) : p.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <input
          type="date"
          aria-label={t('detectionIntelligence.dateRangeFilter.fromDate', 'From date')}
          value={fromStr}
          max={toStr || undefined}
          onChange={(e) => pickCustom(e.target.value, toStr)}
          className={`${dateInputClass} ${selection === 'custom' && fromStr ? 'border-primary/50' : ''}`}
        />
        <span className="text-[11px] text-foreground-subtle">→</span>
        <input
          type="date"
          aria-label={t('detectionIntelligence.dateRangeFilter.toDate', 'To date')}
          value={toStr}
          min={fromStr || undefined}
          onChange={(e) => pickCustom(fromStr, e.target.value)}
          className={`${dateInputClass} ${selection === 'custom' && toStr ? 'border-primary/50' : ''}`}
        />
      </div>
    </div>
  )
}
