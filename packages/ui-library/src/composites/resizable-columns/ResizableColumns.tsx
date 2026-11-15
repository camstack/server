import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from 'react'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import {
  MIN_COLUMN_PCT,
  readStoredSplit,
  resizeSplit,
  writeStoredSplit,
} from './resizable-columns-model'

/** Share of the row one arrow key press moves a boundary, in percent. */
const KEY_STEP_PCT = 2

export interface ResizableColumn {
  readonly id: string
  readonly content: ReactNode
  /** Extra classes of the column's box (scrolling, direction). */
  readonly className?: string
}

export interface ResizableColumnsProps {
  readonly columns: readonly ResizableColumn[]
  /** Starting shares in percent, one per column; scaled to 100. */
  readonly defaultSizes: readonly number[]
  /** Where this viewer's split is remembered (localStorage), per column count. */
  readonly storageKey: string
  readonly className?: string
  readonly testId?: string
}

/**
 * A row of columns the viewer can resize by dragging the handle between two of them
 * (or with the arrow keys on the focused handle). The split is remembered per viewer.
 */
export function ResizableColumns(props: ResizableColumnsProps): ReactNode {
  const t = useUiText()
  const testId = props.testId ?? 'resizable-columns'
  const row = useRef<HTMLDivElement>(null)
  const drag = useRef<{ index: number; x: number; sizes: readonly number[] } | null>(null)
  const [sizes, setSizes] = useState<readonly number[]>(() =>
    readStoredSplit(props.storageKey, props.defaultSizes),
  )
  const shown = sizes.length === props.columns.length ? sizes : props.defaultSizes
  const apply = useCallback(
    (next: readonly number[]): void => {
      setSizes(next)
      writeStoredSplit(props.storageKey, next)
    },
    [props.storageKey],
  )
  const onPointerDown = (index: number) => (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { index, x: event.clientX, sizes: shown }
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const start = drag.current
    const width = row.current?.getBoundingClientRect().width ?? 0
    if (start === null || width <= 0) return
    const delta = ((event.clientX - start.x) / width) * 100
    setSizes(resizeSplit(start.sizes, start.index, delta))
  }
  const onPointerUp = (): void => {
    if (drag.current === null) return
    drag.current = null
    writeStoredSplit(props.storageKey, shown)
  }
  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const step = event.key === 'ArrowLeft' ? -KEY_STEP_PCT : KEY_STEP_PCT
    apply(resizeSplit(shown, index, step))
  }
  return (
    <div ref={row} data-testid={testId} className={cn('flex min-h-0 min-w-0', props.className)}>
      {props.columns.map((column, index) => (
        <div key={column.id} className="contents">
          <div
            data-testid={`${testId}-${column.id}`}
            className={cn('flex min-h-0 min-w-0 flex-col', column.className)}
            // ui-check-ok: the dragged column share is computed geometry, not a colour or spacing
            style={{ flexBasis: `${String(shown[index] ?? 0)}%`, flexGrow: 0, flexShrink: 1 }}
          >
            {column.content}
          </div>
          {index < props.columns.length - 1 && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('uiLibrary.resizableColumns.handle', 'Resize columns')}
              aria-valuemin={MIN_COLUMN_PCT}
              aria-valuenow={Math.round(shown[index] ?? 0)}
              tabIndex={0}
              data-testid={`${testId}-handle-${String(index)}`}
              className="group relative w-px shrink-0 cursor-col-resize touch-none bg-border outline-none hover:bg-primary focus-visible:bg-primary"
              onPointerDown={onPointerDown(index)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onKeyDown(index)}
            >
              <span className="absolute inset-y-0 -left-1.5 -right-1.5" aria-hidden="true" />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
