import type { ReactNode } from 'react'
import { Button } from '../../primitives/button'
import type { TemplateSuggestion } from './device-template-model'

export interface DeviceTemplateSuggestProps {
  readonly open: boolean
  readonly suggestions: readonly TemplateSuggestion[]
  readonly active: number
  readonly testId: string
  readonly onHover: (index: number) => void
  readonly onChoose: (suggestion: TemplateSuggestion) => void
}

/** Suggestions for the caret. In the layout under the text box, so a dialog does not clip it. */
export function DeviceTemplateSuggest(props: DeviceTemplateSuggestProps): ReactNode {
  if (!props.open) return null
  return (
    <ul
      role="listbox"
      data-testid={`${props.testId}-suggest`}
      className="mt-1 max-h-48 w-full overflow-auto rounded-md border border-border bg-surface py-1 shadow-md"
    >
      {props.suggestions.length === 0 ? (
        <li className="px-2 py-1 text-xs text-foreground-subtle">Nothing matches</li>
      ) : (
        props.suggestions.map((item, index) => (
          <li key={item.id} role="presentation">
            <Button
              type="button"
              variant="unstyled"
              role="option"
              aria-selected={index === props.active}
              data-testid={`${props.testId}-suggest-${item.id}`}
              className={
                index === props.active
                  ? 'flex w-full items-baseline justify-between gap-2 bg-surface-hover px-2 py-1 text-left text-xs'
                  : 'flex w-full items-baseline justify-between gap-2 px-2 py-1 text-left text-xs hover:bg-surface-hover'
              }
              onMouseEnter={() => props.onHover(index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => props.onChoose(item)}
            >
              <span className="font-mono text-foreground">{item.label}</span>
              <span className="truncate text-foreground-muted">{item.detail}</span>
            </Button>
          </li>
        ))
      )}
    </ul>
  )
}
