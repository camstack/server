/**
 * Two columns from `sm` (640px) up. Below that, one step: the device list,
 * or the values with a way back. Members add a picked count and Done on the
 * list; Done opens the values step inside the same dialog.
 */
import { Button } from '@camstack/ui-library'
import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { phoneColumnVisible, type SourceSelectorStep } from './source-selector-steps'

export interface SourceSelectorBack {
  readonly label: ReactNode
  readonly ariaLabel: string
}

export interface SourceSelectorDone {
  readonly countLabel: string
  readonly label: string
  readonly disabled: boolean
}

export interface SourceSelectorColumnsProps {
  readonly step: SourceSelectorStep
  readonly devices: ReactNode
  readonly values: ReactNode
  readonly back: SourceSelectorBack | null
  readonly onBack: () => void
  readonly done: SourceSelectorDone | null
  readonly onDone: () => void
}

/** `hidden sm:block` — absent from the phone step, present from 640px up. */
function columnClass(step: SourceSelectorStep, column: SourceSelectorStep): string | undefined {
  return phoneColumnVisible(step, column) ? undefined : 'hidden sm:block'
}

export function SourceSelectorColumns({
  step,
  devices,
  values,
  back,
  onBack,
  done,
  onDone,
}: SourceSelectorColumnsProps): ReactNode {
  return (
    <div
      data-testid="source-selector"
      data-step={step}
      className="flex flex-col gap-3 sm:grid sm:grid-cols-2 sm:gap-4"
    >
      <div data-testid="source-selector-devices" className={columnClass(step, 'devices')}>
        {done !== null && (
          <div className="mb-2 flex items-center justify-between gap-2 sm:hidden">
            <p
              data-testid="source-selector-picked-count"
              className="text-[11px] text-foreground-muted"
            >
              {done.countLabel}
            </p>
            <Button
              size="sm"
              data-testid="source-selector-done"
              disabled={done.disabled}
              onClick={onDone}
            >
              {done.label}
            </Button>
          </div>
        )}
        {devices}
      </div>
      <div data-testid="source-selector-values" className={columnClass(step, 'values')}>
        {back !== null && (
          <Button
            variant="ghost"
            size="sm"
            className="mb-2 sm:hidden"
            data-testid="source-selector-back"
            aria-label={back.ariaLabel}
            onClick={onBack}
          >
            <ChevronLeft className="size-3" />
            {back.label}
          </Button>
        )}
        {values}
      </div>
    </div>
  )
}
