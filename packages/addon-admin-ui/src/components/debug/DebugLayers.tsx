/**
 * Debug layers (planning#362) — an instrument, not a fix. Open the admin with
 * `?debugLayers=1` (remembered for the session; `?debugLayers=0` ends it) or the
 * "Debug layers" item in the menu (for the installed app, which has no URL bar) and
 * every element near the top of the viewport that can blur, dim or paint over
 * what is behind it gets an outline and a label (tag, classes, z-index, the
 * offending property); a corner badge shows the safe-area insets and the
 * admin-ui version. Read what it prints on the device that misbehaves.
 *
 * It is operator tooling for one device-specific bug, so its labels are plain
 * English, not translated. Classification lives in `lib/debug-layers.ts`.
 */
import { cn } from '@camstack/ui-library'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { Switch } from '@camstack/ui-library'
import {
  DEBUG_NO_BLUR_CLASS,
  classifyLayer,
  describeLayer,
  type LayerReason,
} from '../../lib/debug-layers'
import { useDebugLayers } from '../../lib/debug-layers-store'

const ROOT_ATTR = 'data-debug-layers'
const RESCAN_MS = 250
const MAX_FINDINGS = 60

interface Box {
  readonly id: number
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
  readonly label: string
  readonly reasons: readonly LayerReason[]
}

interface Insets {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

function scan(): readonly Box[] {
  const boxes: Box[] = []
  const all = document.body.querySelectorAll('*')
  for (const el of Array.from(all)) {
    if (boxes.length >= MAX_FINDINGS) break
    if (el.closest(`[${ROOT_ATTR}]`) !== null) continue
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || rect.top >= 120 || rect.bottom <= 0) continue
    const cs = getComputedStyle(el)
    const finding = classifyLayer(
      {
        position: cs.position,
        zIndex: cs.zIndex,
        opacity: cs.opacity,
        filter: cs.filter,
        backdropFilter: cs.backdropFilter,
        webkitBackdropFilter: cs.getPropertyValue('-webkit-backdrop-filter'),
        transform: cs.transform,
        perspective: cs.perspective,
        isolation: cs.isolation,
        mixBlendMode: cs.mixBlendMode,
        willChange: cs.willChange,
      },
      rect,
    )
    if (finding === null) continue
    const testId = el.getAttribute('data-testid')
    boxes.push({
      id: boxes.length,
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      label: describeLayer(
        el.tagName,
        typeof el.className === 'string' ? el.className : '',
        testId === null ? null : `data-testid=${testId}`,
        finding,
      ),
      reasons: finding.reasons,
    })
  }
  return boxes
}

/** `env(safe-area-inset-*)` resolved to pixels through a throw-away probe. */
function readInsets(probe: HTMLElement): Insets {
  const cs = getComputedStyle(probe)
  const px = (v: string): number => Number.parseFloat(v) || 0
  return {
    top: px(cs.paddingTop),
    right: px(cs.paddingRight),
    bottom: px(cs.paddingBottom),
    left: px(cs.paddingLeft),
  }
}

function toneOf(reasons: readonly LayerReason[]): {
  outline: string
  chip: string
} {
  if (reasons.includes('backdrop-filter') || reasons.includes('filter')) {
    return { outline: 'outline-danger', chip: 'bg-danger' }
  }
  if (reasons.includes('opacity') || reasons.includes('mix-blend-mode')) {
    return { outline: 'outline-warning', chip: 'bg-warning' }
  }
  if (reasons.includes('fixed') || reasons.includes('sticky')) {
    return { outline: 'outline-info', chip: 'bg-info' }
  }
  return { outline: 'outline-primary', chip: 'bg-primary' }
}

function isStandalone(): boolean {
  // Safari's own flag for a home-screen web app; not in the DOM typings.
  const standalone: unknown = Reflect.get(navigator, 'standalone')
  return window.matchMedia('(display-mode: standalone)').matches || standalone === true
}

function appVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
}

/**
 * A modal `<dialog>` lives in the browser's top layer, above any z-index. A
 * manual popover joins the same layer, and re-showing it puts it last, so the
 * outlines stay visible over an open dialog. A browser without the Popover
 * API keeps the plain fixed overlay.
 */
function raiseToTopLayer(el: HTMLElement | null): void {
  if (el === null || typeof el.showPopover !== 'function') return
  try {
    if (el.matches(':popover-open')) el.hidePopover()
    el.showPopover()
  } catch {
    // Not attached yet, or the popover is already in the state asked for.
  }
}

function DebugLayersOverlay({
  noBlur,
  onNoBlurChange,
}: {
  readonly noBlur: boolean
  readonly onNoBlurChange: (noBlur: boolean) => void
}): ReactNode {
  const [boxes, setBoxes] = useState<readonly Box[]>([])
  const [insets, setInsets] = useState<Insets>({
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  })
  const probe = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)

  const refresh = useCallback(() => {
    raiseToTopLayer(root.current)
    setBoxes(scan())
    if (probe.current !== null) setInsets(readInsets(probe.current))
  }, [])

  const schedule = useCallback(() => {
    if (timer.current !== null) return
    timer.current = window.setTimeout(() => {
      timer.current = null
      refresh()
    }, RESCAN_MS)
  }, [refresh])

  useEffect(() => {
    refresh()
    const observer = new MutationObserver((records) => {
      // Our own overlay re-rendering must not trigger another scan.
      const outside = records.some(
        (r) => !(r.target instanceof Element && r.target.closest(`[${ROOT_ATTR}]`) !== null),
      )
      if (outside) schedule()
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    })
    window.addEventListener('resize', schedule)
    window.addEventListener('orientationchange', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('orientationchange', schedule)
      window.removeEventListener('scroll', schedule, true)
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [refresh, schedule])

  // Portalled to <body>: inside the app tree an ancestor's stacking context would cap its z-index.
  return createPortal(
    <div
      {...{ [ROOT_ATTR]: '' }}
      ref={root}
      popover="manual"
      className="pointer-events-none fixed inset-0 z-[2147483647] m-0 h-full w-full overflow-visible border-0 bg-transparent p-0"
    >
      <div
        ref={probe}
        aria-hidden
        className="invisible absolute h-0 w-0"
        // ui-check-ok: probe resolving env(safe-area-inset-*) to pixels; no visual styling
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingRight: 'env(safe-area-inset-right)',
          paddingBottom: 'env(safe-area-inset-bottom)',
          paddingLeft: 'env(safe-area-inset-left)',
        }}
      />
      {boxes.map((box) => {
        const tone = toneOf(box.reasons)
        return (
          <div
            key={box.id}
            data-testid="debug-layer-box"
            className={cn('absolute outline outline-1 -outline-offset-1', tone.outline)}
            // ui-check-ok: measured viewport rectangle of the inspected element
            style={{
              top: box.top,
              left: box.left,
              width: box.width,
              height: box.height,
            }}
          >
            <span
              className={cn(
                'absolute left-0 max-w-[90vw] truncate px-1 font-mono text-[9px] leading-3 text-primary-foreground',
                tone.chip,
              )}
              // ui-check-ok: stagger labels so stacked layers stay readable
              style={{ top: (box.id % 6) * 12 }}
            >
              {box.label}
            </span>
          </div>
        )
      })}
      <div
        data-testid="debug-layers-badge"
        className="absolute right-1 top-14 rounded-md bg-background-elevated px-2 py-1 font-mono text-[10px] leading-4 text-foreground outline outline-1 outline-border"
      >
        <div>admin-ui {appVersion()}</div>
        <div>
          inset t{insets.top} r{insets.right} b{insets.bottom} l{insets.left}
        </div>
        <div>
          display-mode standalone:{' '}
          {window.matchMedia('(display-mode: standalone)').matches ? 'yes' : 'no'}
          {' · '}navigator.standalone: {isStandalone() ? 'yes' : 'no'}
        </div>
        <div>
          {window.innerWidth}x{window.innerHeight} · {boxes.length} layers
        </div>
        <Switch
          checked={noBlur}
          onCheckedChange={onNoBlurChange}
          label="no backdrop blur"
          className="pointer-events-auto mt-1 text-[10px]"
        />
      </div>
    </div>,
    document.body,
  )
}

/** Mounted once in the app: renders nothing unless the mode is on. */
export function DebugLayers(): ReactNode {
  const { on, noBlur, setNoBlur } = useDebugLayers()
  // Debug-only exception to "no blur in the shell": the rule behind this class
  // (index.css) strips every backdrop-filter so sharpness can be compared live.
  useEffect(() => {
    const active = on && noBlur
    document.documentElement.classList.toggle(DEBUG_NO_BLUR_CLASS, active)
    return () => document.documentElement.classList.remove(DEBUG_NO_BLUR_CLASS)
  }, [on, noBlur])
  return on ? <DebugLayersOverlay noBlur={noBlur} onNoBlurChange={setNoBlur} /> : null
}
