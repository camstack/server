/**
 * "Points n/m ▾": a compact multi-select of the points a History block
 * draws. Every point starts on. The popover lists one checkbox per point
 * with All / None above it; the state is the OFF set, as everywhere in the
 * History view.
 */
import type { JSX } from 'react'
import { ChevronDown } from 'lucide-react'
import { useUiText } from '../../contexts/ui-text'
import { Button } from '../../primitives/button'
import { Checkbox } from '../../primitives/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover'

export interface PointOption {
  readonly id: string
  readonly label: string
}

export interface PointsSelectProps {
  readonly points: readonly PointOption[]
  /** Ids switched OFF. Empty = all on. */
  readonly off: ReadonlySet<string>
  readonly onChange: (off: ReadonlySet<string>) => void
  readonly testId?: string
}

export function PointsSelect({ points, off, onChange, testId }: PointsSelectProps): JSX.Element {
  const t = useUiText()
  const on = points.filter((p) => !off.has(p.id)).length
  const toggle = (id: string): void => {
    const next = new Set(off)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }
  return (
    <Popover>
      <PopoverTrigger
        data-testid={testId}
        className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2 text-xs text-foreground hover:bg-surface-hover"
      >
        {t('uiLibrary.history.pointsCount', 'Points {{on}}/{{total}}', {
          on,
          total: points.length,
        })}
        <ChevronDown className="h-3 w-3" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-64 rounded-md border border-border bg-background-elevated p-2 shadow-lg">
        <div className="mb-1 flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(new Set())}
            data-testid={testId === undefined ? undefined : `${testId}-all`}
          >
            {t('uiLibrary.history.allPoints', 'All')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(new Set(points.map((p) => p.id)))}
            data-testid={testId === undefined ? undefined : `${testId}-none`}
          >
            {t('uiLibrary.history.noPoints', 'None')}
          </Button>
        </div>
        <ul className="flex max-h-64 flex-col overflow-y-auto">
          {points.map((p) => (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-xs text-foreground hover:bg-surface-hover">
                <Checkbox
                  checked={!off.has(p.id)}
                  onChange={() => toggle(p.id)}
                  data-testid={testId === undefined ? undefined : `${testId}-${p.id}`}
                />
                <span className="min-w-0 truncate">{p.label}</span>
              </label>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
