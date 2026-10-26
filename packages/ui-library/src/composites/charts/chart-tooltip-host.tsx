/**
 * One tooltip for every chart. The plot stays in `UPlotHost`; this shell
 * tracks the pointer, a touch scrub and the arrow keys, and draws the
 * readout inside the chart.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import type uPlot from 'uplot'
import { cn } from '../../lib/cn'
import {
  HIDDEN_INTERACTION,
  dataXFromPointer,
  placeChartTooltip,
  reduceChartInteraction,
  stepStop,
  type ChartInteraction,
  type ChartPointerKind,
  type ChartTooltipBody,
} from './chart-tooltip-model'

export type ChartKind = 'lines' | 'states' | 'bars' | 'spark'

export interface ChartTooltipSpec {
  readonly xMin: number
  readonly xMax: number
  readonly stops: readonly number[]
  /** `null` means this x has nothing to show (the tooltip hides). */
  readonly resolve: (dataX: number) => ChartTooltipBody | null
  /** The chart's own cursor (legend, state label) follows the selection. */
  readonly onDataX?: (dataX: number | null) => void
}

export interface ChartTooltipShellProps {
  readonly spec: ChartTooltipSpec | null
  readonly plotRef: RefObject<uPlot | null>
  readonly kind?: ChartKind
  readonly label?: string
  readonly inline?: boolean
  readonly children: ReactNode
}

interface TooltipView {
  readonly body: ChartTooltipBody
  readonly anchorX: number
  readonly anchorY: number
  readonly boundsWidth: number
  readonly boundsHeight: number
}

interface PointerSample {
  readonly dataX: number | null
  readonly anchorX: number
  readonly anchorY: number
  readonly inside: boolean
}

interface AnchorPoint {
  readonly x: number
  readonly y: number
}

function pointerKind(pointerType: string): ChartPointerKind {
  return pointerType === 'mouse' ? 'mouse' : 'touch'
}

function pointerSample(
  clientX: number,
  clientY: number,
  shell: HTMLElement,
  plot: uPlot | null,
  spec: ChartTooltipSpec,
  clamp: boolean,
): PointerSample {
  const box = shell.getBoundingClientRect()
  const anchorX = clientX - box.left
  const anchorY = clientY - box.top
  if (plot !== null) {
    const over = plot.over.getBoundingClientRect()
    const left = clientX - over.left
    const top = clientY - over.top
    const minX = plot.bbox.left
    const maxX = plot.bbox.left + plot.bbox.width
    const inside =
      left >= minX &&
      left <= maxX &&
      top >= plot.bbox.top &&
      top <= plot.bbox.top + plot.bbox.height
    if (!inside && !clamp) return { dataX: null, anchorX, anchorY, inside: false }
    return {
      dataX: plot.posToVal(Math.min(maxX, Math.max(minX, left)), 'x'),
      anchorX,
      anchorY,
      inside,
    }
  }
  const dataX = dataXFromPointer({
    localX: anchorX,
    plotLeft: 0,
    plotWidth: box.width,
    xMin: spec.xMin,
    xMax: spec.xMax,
    clamp,
  })
  return { dataX, anchorX, anchorY, inside: dataX !== null }
}

function anchorForDataX(
  dataX: number,
  shell: HTMLElement | null,
  plot: uPlot | null,
  spec: ChartTooltipSpec,
): AnchorPoint {
  if (plot !== null && shell !== null) {
    const over = plot.over.getBoundingClientRect()
    const box = shell.getBoundingClientRect()
    return {
      x: over.left - box.left + plot.valToPos(dataX, 'x'),
      y: over.top - box.top + plot.bbox.top + plot.bbox.height / 2,
    }
  }
  const width = shell?.getBoundingClientRect().width ?? 0
  const height = shell?.getBoundingClientRect().height ?? 0
  const span = spec.xMax - spec.xMin
  const frac = span === 0 ? 0 : (dataX - spec.xMin) / span
  return { x: Math.min(1, Math.max(0, frac)) * width, y: height / 2 }
}

function movePlotCursor(plot: uPlot | null, dataX: number | null): void {
  if (plot === null) return
  if (dataX === null) {
    plot.setCursor({ left: -10, top: -10 })
    return
  }
  plot.setCursor({ left: plot.valToPos(dataX, 'x'), top: plot.bbox.top + plot.bbox.height / 2 })
}

interface ChartTooltipCardProps {
  readonly view: TooltipView
}

function ChartTooltipCard({ view }: ChartTooltipCardProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const placed = placeChartTooltip({
      anchorX: view.anchorX,
      anchorY: view.anchorY,
      tooltipWidth: el.offsetWidth,
      tooltipHeight: el.offsetHeight,
      boundsWidth: view.boundsWidth,
      boundsHeight: view.boundsHeight,
    })
    el.style.left = `${String(placed.left)}px`
    el.style.top = `${String(placed.top)}px`
  }, [view])
  return (
    <div
      ref={ref}
      role="tooltip"
      data-chart-tooltip=""
      className="pointer-events-none absolute z-20 max-w-64 rounded-md border border-border bg-background-elevated px-2 py-1 text-foreground shadow-md"
    >
      <p className="m-0 text-[10px] tabular-nums text-foreground-subtle">{view.body.heading}</p>
      <ul className="m-0 list-none p-0">
        {view.body.lines.map((line) => (
          <li key={line.id} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="min-w-0 truncate text-foreground-muted">{line.label}</span>
            <span className="shrink-0 tabular-nums">{line.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ChartTooltipShell({
  spec,
  plotRef,
  kind,
  label,
  inline = false,
  children,
}: ChartTooltipShellProps): JSX.Element {
  const shellRef = useRef<HTMLElement | null>(null)
  const specRef = useRef<ChartTooltipSpec | null>(spec)
  specRef.current = spec
  const interactionRef = useRef<ChartInteraction>(HIDDEN_INTERACTION)
  const dataXRef = useRef<number | null>(null)
  const [view, setView] = useState<TooltipView | null>(null)
  const pinned = view !== null && interactionRef.current.selection.pinned

  const commit = useCallback((next: ChartInteraction): void => {
    interactionRef.current = next
    const current = specRef.current
    const shell = shellRef.current
    const dataX = next.selection.visible ? next.selection.dataX : null
    const body = current !== null && dataX !== null ? current.resolve(dataX) : null
    if (body === null || dataX === null) {
      setView(null)
      if (dataXRef.current !== null) {
        dataXRef.current = null
        current?.onDataX?.(null)
      }
      return
    }
    setView({
      body,
      anchorX: next.selection.anchorX,
      anchorY: next.selection.anchorY,
      boundsWidth: shell?.getBoundingClientRect().width ?? 0,
      boundsHeight: shell?.getBoundingClientRect().height ?? 0,
    })
    if (dataXRef.current !== dataX) {
      dataXRef.current = dataX
      current?.onDataX?.(dataX)
    }
  }, [])

  useEffect(() => {
    const shell = shellRef.current
    if (shell === null) return
    const sample = (event: PointerEvent, clamp: boolean): PointerSample | null => {
      const current = specRef.current
      if (current === null) return null
      return pointerSample(event.clientX, event.clientY, shell, plotRef.current, current, clamp)
    }
    const onDown = (event: PointerEvent): void => {
      if (pointerKind(event.pointerType) === 'mouse') return
      const at = sample(event, false)
      if (at === null) return
      commit(
        reduceChartInteraction(interactionRef.current, {
          type: 'down',
          kind: 'touch',
          x: at.anchorX,
          y: at.anchorY,
          dataX: at.dataX,
        }),
      )
    }
    const onMove = (event: PointerEvent): void => {
      const kind = pointerKind(event.pointerType)
      const scrubbing = interactionRef.current.gesture?.axis === 'x'
      const at = sample(event, kind !== 'mouse' && scrubbing)
      if (at === null) return
      if (kind === 'mouse') {
        if (!at.inside || at.dataX === null) {
          commit(reduceChartInteraction(interactionRef.current, { type: 'leave' }))
          if (!interactionRef.current.selection.visible) movePlotCursor(plotRef.current, null)
          return
        }
        commit(
          reduceChartInteraction(interactionRef.current, {
            type: 'hover',
            dataX: at.dataX,
            anchorX: at.anchorX,
            anchorY: at.anchorY,
          }),
        )
        movePlotCursor(plotRef.current, at.dataX)
        return
      }
      const next = reduceChartInteraction(interactionRef.current, {
        type: 'move',
        kind: 'touch',
        x: at.anchorX,
        y: at.anchorY,
        dataX: at.dataX,
      })
      if (next.lockHorizontalScroll) {
        event.preventDefault()
        // pointerId 0 is a test DOM; a real touch id is captured so the scrub survives leaving the plot.
        if (event.pointerId !== 0 && !shell.hasPointerCapture(event.pointerId)) {
          shell.setPointerCapture(event.pointerId)
        }
      }
      commit(next)
      if (next.selection.dataX !== null && next.selection.visible) {
        movePlotCursor(plotRef.current, next.selection.dataX)
      }
    }
    const onUp = (event: PointerEvent): void => {
      if (pointerKind(event.pointerType) === 'mouse') return
      const at = sample(event, interactionRef.current.gesture?.axis === 'x')
      if (at === null) return
      const next = reduceChartInteraction(interactionRef.current, {
        type: 'up',
        kind: 'touch',
        x: at.anchorX,
        y: at.anchorY,
        dataX: at.dataX,
      })
      commit(next)
      movePlotCursor(plotRef.current, next.selection.visible ? next.selection.dataX : null)
    }
    const onLeave = (event: PointerEvent): void => {
      if (pointerKind(event.pointerType) !== 'mouse') return
      const next = reduceChartInteraction(interactionRef.current, { type: 'leave' })
      commit(next)
      if (!next.selection.visible) movePlotCursor(plotRef.current, null)
    }
    shell.addEventListener('pointerdown', onDown)
    shell.addEventListener('pointermove', onMove)
    shell.addEventListener('pointerup', onUp)
    shell.addEventListener('pointercancel', onUp)
    shell.addEventListener('pointerleave', onLeave)
    return () => {
      shell.removeEventListener('pointerdown', onDown)
      shell.removeEventListener('pointermove', onMove)
      shell.removeEventListener('pointerup', onUp)
      shell.removeEventListener('pointercancel', onUp)
      shell.removeEventListener('pointerleave', onLeave)
    }
  }, [commit, plotRef])

  useEffect(() => {
    if (!pinned) return
    const onDoc = (event: PointerEvent): void => {
      const shell = shellRef.current
      if (shell !== null && event.target instanceof Node && shell.contains(event.target)) return
      commit(reduceChartInteraction(interactionRef.current, { type: 'outside' }))
      movePlotCursor(plotRef.current, null)
    }
    document.addEventListener('pointerdown', onDoc, true)
    return () => document.removeEventListener('pointerdown', onDoc, true)
  }, [commit, pinned, plotRef])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const current = specRef.current
    if (current === null) return
    if (event.key === 'Escape') {
      event.preventDefault()
      commit(reduceChartInteraction(interactionRef.current, { type: 'hide' }))
      movePlotCursor(plotRef.current, null)
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const from = interactionRef.current.selection.visible
      ? interactionRef.current.selection.dataX
      : null
    const dataX = stepStop(current.stops, from, event.key === 'ArrowRight' ? 1 : -1)
    if (dataX === null) return
    const anchor = anchorForDataX(dataX, shellRef.current, plotRef.current, current)
    commit(
      reduceChartInteraction(interactionRef.current, {
        type: 'key',
        dataX,
        anchorX: anchor.x,
        anchorY: anchor.y,
      }),
    )
    movePlotCursor(plotRef.current, dataX)
  }

  const setShell = (el: HTMLElement | null): void => {
    shellRef.current = el
  }
  const className = cn(
    'relative min-w-0 touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-primary',
    inline ? 'inline-block w-full' : 'w-full',
  )
  const tooltip = view !== null ? <ChartTooltipCard view={view} /> : null
  const live =
    view !== null && typeof document !== 'undefined'
      ? createPortal(
          <div className="sr-only" aria-live="polite" data-chart-tooltip-live="">
            {view.body.liveText}
          </div>,
          document.body,
        )
      : null
  const shared = {
    className,
    'data-chart-shell': '',
    'data-chart-kind': kind,
    tabIndex: spec === null ? undefined : 0,
    'aria-label': label,
    onKeyDown,
  }
  return inline ? (
    <span ref={setShell} {...shared}>
      {children}
      {tooltip}
      {live}
    </span>
  ) : (
    <div ref={setShell} {...shared}>
      {children}
      {tooltip}
      {live}
    </div>
  )
}
