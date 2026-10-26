/**
 * The one place the chart family touches uPlot.
 *
 * - uPlot is imported LAZILY: its module reads `matchMedia` at load time, and
 *   a document without a 2D canvas (a test DOM, a print preview) has nothing
 *   for it to draw on. There the chart's DOM half — title, legend, readout and
 *   the accessible summary — still renders; only the plot is absent.
 * - Width follows the container (`ResizeObserver`); the height is the caller's.
 * - A theme switch (`.dark` / `.light` on `<html>`) only REDRAWS: every colour
 *   is a function that resolves its token at draw time (`chart-palette.ts`).
 * - `optionsKey` decides when the plot is rebuilt (series set, axes); new
 *   `data` under the same key is a cheap `setData`.
 */
import { useEffect, useRef, useState, type JSX } from 'react'
import type uPlot from 'uplot'
import { ChartTooltipShell, type ChartKind, type ChartTooltipSpec } from './chart-tooltip-host'

export type UPlotCtor = typeof uPlot

/** Options without the size: the host owns width (the container) and height (the prop). */
export type ChartPlotOptions = Omit<uPlot.Options, 'width' | 'height'>

let ctorPromise: Promise<UPlotCtor | null> | null = null

/** A 2D canvas this document can draw on — false in a test DOM. */
export function canDrawCanvas(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false
  if (typeof window.matchMedia !== 'function') return false
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    return ctx !== null
  } catch {
    return false
  }
}

function loadUPlot(): Promise<UPlotCtor | null> {
  if (ctorPromise === null) {
    ctorPromise = canDrawCanvas()
      ? import('uplot').then((m) => m.default).catch(() => null)
      : Promise.resolve(null)
  }
  return ctorPromise
}

export interface UPlotHostProps {
  /** Rebuild the plot when this changes (series set, axes, scales). */
  readonly optionsKey: string
  /** Build the options for a width; called on (re)build only. `lib` carries uPlot's path builders. */
  readonly buildOptions: (width: number, lib: UPlotCtor) => ChartPlotOptions
  readonly data: uPlot.AlignedData
  readonly height: number
  /** Called with the live instance after each (re)build, and `null` when it goes. */
  readonly onInstance?: (u: uPlot | null) => void
  readonly className?: string
  /** Render a `<span class="block">` host, for a plot inside phrasing content. */
  readonly inline?: boolean
  /** Point tooltip. Absent on a plot that has nothing to select. */
  readonly tooltip?: ChartTooltipSpec | null
  /** Which chart this plot is, so a shot can aim the pointer at one of them. */
  readonly kind?: ChartKind
  /** Accessible name for the focusable plot. */
  readonly label?: string
}

export type { ChartKind, ChartTooltipSpec }

export function UPlotHost({
  optionsKey,
  buildOptions,
  data,
  height,
  onInstance,
  className,
  inline = false,
  tooltip = null,
  kind,
  label,
}: UPlotHostProps): JSX.Element {
  const hostRef = useRef<HTMLElement | null>(null)
  const plotRef = useRef<uPlot | null>(null)
  const [ctor, setCtor] = useState<UPlotCtor | null>(null)
  const latest = useRef({ buildOptions, data, onInstance })
  latest.current = { buildOptions, data, onInstance }

  useEffect(() => {
    let alive = true
    void loadUPlot().then((c) => {
      if (alive && c !== null) setCtor(() => c)
    })
    return () => {
      alive = false
    }
  }, [])

  // (Re)build on key / ctor / height change.
  useEffect(() => {
    const el = hostRef.current
    if (ctor === null || el === null) return
    const width = Math.max(1, Math.floor(el.clientWidth))
    const opts = { ...latest.current.buildOptions(width, ctor), width, height }
    const u = new ctor(opts, latest.current.data, el)
    // The finger hits uPlot's overlay, and touch-action is not inherited.
    u.over.style.touchAction = 'pan-y'
    u.root.style.touchAction = 'pan-y'
    plotRef.current = u
    latest.current.onInstance?.(u)
    return () => {
      latest.current.onInstance?.(null)
      u.destroy()
      plotRef.current = null
    }
  }, [ctor, optionsKey, height])

  // New data under the same options.
  useEffect(() => {
    plotRef.current?.setData(data)
  }, [data])

  // Width follows the container.
  useEffect(() => {
    const el = hostRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0)
      const u = plotRef.current
      if (u !== null && w > 0 && w !== u.width) u.setSize({ width: w, height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [height])

  // A theme flip only repaints.
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const mo = new MutationObserver(() => plotRef.current?.redraw(false, true))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])

  const setHost = (el: HTMLElement | null): void => {
    hostRef.current = el
  }
  const plot = inline ? (
    <span ref={setHost} className={className ?? 'block w-full min-w-0'} data-chart-plot="" />
  ) : (
    <div ref={setHost} className={className ?? 'w-full min-w-0'} data-chart-plot="" />
  )
  return (
    <ChartTooltipShell spec={tooltip} plotRef={plotRef} kind={kind} label={label} inline={inline}>
      {plot}
    </ChartTooltipShell>
  )
}
