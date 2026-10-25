import {
  type HTMLAttributes,
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../lib/cn'
import { IconButton } from './icon-button'

export interface TabStripOverflowState {
  readonly overflowLeft: boolean
  readonly overflowRight: boolean
}

/** Scroll offsets and sizes — jsdom defaults are 0, so tests set these explicitly. */
export function readTabStripOverflow(el: HTMLDivElement): TabStripOverflowState {
  const epsilon = 1
  const { scrollLeft, scrollWidth, clientWidth } = el
  const hasOverflow = scrollWidth > clientWidth + epsilon
  return {
    overflowLeft: hasOverflow && scrollLeft > epsilon,
    overflowRight: hasOverflow && scrollLeft + clientWidth < scrollWidth - epsilon,
  }
}

function scrollTabIntoViewNearest(tab: HTMLElement): void {
  if (typeof tab.scrollIntoView === 'function') {
    tab.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }
}

function scrollStripByOneTab(el: HTMLDivElement, direction: 'left' | 'right'): void {
  const tabs = el.querySelectorAll<HTMLElement>('[role="tab"]')
  if (tabs.length === 0) return
  const scrollLeft = el.scrollLeft
  if (direction === 'right') {
    for (const tab of tabs) {
      if (tab.offsetLeft + tab.offsetWidth > scrollLeft + 1) {
        scrollTabIntoViewNearest(tab)
        return
      }
    }
    return
  }
  for (let i = tabs.length - 1; i >= 0; i--) {
    const tab = tabs[i]
    if (tab === undefined) continue
    if (tab.offsetLeft < scrollLeft - 1) {
      scrollTabIntoViewNearest(tab)
      return
    }
  }
}

function scrollActiveTabIntoView(el: HTMLDivElement): void {
  const active = el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
  if (active !== null && typeof active.scrollIntoView === 'function') {
    active.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }
}

interface TabsListScrollShellProps extends HTMLAttributes<HTMLDivElement> {
  readonly activeTabKey?: string
  readonly listClassName: string
  readonly children?: ReactNode
}

/**
 * Horizontally scrollable tab strip with edge fades when tabs are hidden and,
 * on fine-pointer devices, chevron buttons that scroll one tab at a time.
 * Touch keeps native swipe — no chevrons on coarse pointers.
 */
export function TabsListScrollShell({
  activeTabKey,
  listClassName,
  className,
  children,
  ...props
}: TabsListScrollShellProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [overflow, setOverflow] = useState<TabStripOverflowState>({
    overflowLeft: false,
    overflowRight: false,
  })
  const [finePointer, setFinePointer] = useState(false)

  const remeasure = useCallback(() => {
    const el = scrollRef.current
    if (el === null) return
    setOverflow(readTabStripOverflow(el))
  }, [])

  useEffect(() => {
    remeasure()
    const el = scrollRef.current
    if (el === null) return
    el.addEventListener('scroll', remeasure, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(remeasure) : null
    ro?.observe(el)
    for (const child of el.children) {
      ro?.observe(child)
    }
    return () => {
      el.removeEventListener('scroll', remeasure)
      ro?.disconnect()
    }
  }, [remeasure, children])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)')
    const apply = (): void => {
      setFinePointer(mq.matches)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el === null || activeTabKey === undefined) return
    scrollActiveTabIntoView(el)
    remeasure()
  }, [activeTabKey, remeasure])

  const scrollBy = (direction: 'left' | 'right'): void => {
    const el = scrollRef.current
    if (el === null) return
    scrollStripByOneTab(el, direction)
  }

  return (
    <div
      className={cn('relative min-w-0', className)}
      data-tab-strip-overflow-left={overflow.overflowLeft ? '' : undefined}
      data-tab-strip-overflow-right={overflow.overflowRight ? '' : undefined}
    >
      {overflow.overflowLeft && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-8 bg-gradient-to-r from-background to-transparent"
        />
      )}
      {overflow.overflowRight && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 z-[1] w-8 bg-gradient-to-l from-background to-transparent"
        />
      )}
      {finePointer && overflow.overflowLeft && (
        <IconButton
          type="button"
          variant="ghost"
          size="sm"
          icon={ChevronLeft}
          aria-label="Scroll tabs left"
          className="absolute left-0 top-1/2 z-[2] -translate-y-1/2 bg-background/80 shadow-sm"
          onClick={() => scrollBy('left')}
        />
      )}
      {finePointer && overflow.overflowRight && (
        <IconButton
          type="button"
          variant="ghost"
          size="sm"
          icon={ChevronRight}
          aria-label="Scroll tabs right"
          className="absolute right-0 top-1/2 z-[2] -translate-y-1/2 bg-background/80 shadow-sm"
          onClick={() => scrollBy('right')}
        />
      )}
      <div ref={scrollRef} role="tablist" className={listClassName} {...props}>
        {children}
      </div>
    </div>
  )
}
