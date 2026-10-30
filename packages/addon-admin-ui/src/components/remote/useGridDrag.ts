/**
 * Pointer dragging of a button or a group on the remote grid (D973). It only
 * turns pointer events into the pure geometry of `layout-drag`: a press that
 * moves past a small threshold becomes a drag, the target is previewed on every
 * move, and the release asks the layout to make the move. A press that never
 * moves stays a click, and the click that follows a drag is swallowed.
 */
import type { RemoteLayoutPayload } from '@camstack/types'
import { type PointerEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import {
  type Cell,
  cellAt,
  type DragItem,
  type DragPreview,
  dropOrigin,
  itemRect,
  moveItem,
  previewMove,
} from './layout-drag'
import type { LayoutResult } from './layout-model'

/** Pixels the pointer must travel before a press is a drag. */
const DRAG_THRESHOLD_PX = 4

interface Press {
  readonly item: DragItem
  readonly startX: number
  readonly startY: number
  readonly grabbed: Cell
  active: boolean
  target: Cell | null
}

export interface GridDragState {
  readonly item: DragItem
  readonly preview: DragPreview | null
}

export interface UseGridDrag {
  readonly drag: GridDragState | null
  readonly onItemPointerDown: (item: DragItem, event: PointerEvent<HTMLElement>) => void
  /** True once, right after a drag ended, so the click it produces can be ignored. */
  readonly consumeDragClick: () => boolean
}

export function useGridDrag(
  grid: RemoteLayoutPayload,
  gridRef: RefObject<HTMLDivElement | null>,
  onDrop: (result: LayoutResult) => void,
): UseGridDrag {
  const [drag, setDrag] = useState<GridDragState | null>(null)
  const latest = useRef({ grid, onDrop })
  latest.current = { grid, onDrop }
  const stop = useRef<(() => void) | null>(null)
  const justDragged = useRef(false)

  useEffect(() => () => stop.current?.(), [])

  const onItemPointerDown = useCallback(
    (item: DragItem, event: PointerEvent<HTMLElement>): void => {
      const element = gridRef.current
      if (element === null || event.button !== 0) return
      const bounds = element.getBoundingClientRect()
      const rect = itemRect(latest.current.grid, item)
      if (rect === undefined) return
      const press: Press = {
        item,
        startX: event.clientX,
        startY: event.clientY,
        grabbed: cellAt(bounds, latest.current.grid, event.clientX, event.clientY),
        active: false,
        target: null,
      }

      const move = (e: globalThis.PointerEvent): void => {
        if (!press.active) {
          const far = Math.hypot(e.clientX - press.startX, e.clientY - press.startY)
          if (far < DRAG_THRESHOLD_PX) return
          press.active = true
        }
        const current = latest.current.grid
        const here = cellAt(element.getBoundingClientRect(), current, e.clientX, e.clientY)
        const start = itemRect(current, press.item)
        if (start === undefined) return
        press.target = dropOrigin(start, press.grabbed, here)
        setDrag({ item: press.item, preview: previewMove(current, press.item, press.target) })
      }
      const finish = (apply: boolean): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', cancel)
        window.removeEventListener('keydown', key)
        stop.current = null
        setDrag(null)
        if (!press.active) return
        justDragged.current = true
        window.setTimeout(() => {
          justDragged.current = false
        }, 0)
        if (apply && press.target !== null) {
          latest.current.onDrop(moveItem(latest.current.grid, press.item, press.target))
        }
      }
      const up = (): void => finish(true)
      const cancel = (): void => finish(false)
      const key = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') finish(false)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', cancel)
      window.addEventListener('keydown', key)
      stop.current = () => finish(false)
    },
    [gridRef],
  )

  const consumeDragClick = useCallback((): boolean => {
    const was = justDragged.current
    justDragged.current = false
    return was
  }, [])

  return { drag, onItemPointerDown, consumeDragClick }
}
