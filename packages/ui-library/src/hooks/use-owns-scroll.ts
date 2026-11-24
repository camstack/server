import { type RefObject, useEffect, useRef, useState } from 'react'

export interface OwnsScroll<T extends HTMLElement> {
  readonly ref: RefObject<T | null>
  /** True while the element's content is taller than the element: its parent bounds its height. */
  readonly owns: boolean
}

/**
 * Whether a flexible region is really height-bounded by its parent.
 *
 * A region that scrolls inside itself (`overflow-y-auto overscroll-contain`) is
 * right under a parent that gives it a height (a dialog body, a fixed-height
 * panel) and wrong under one that does not: there it never has anything to
 * scroll, yet it still swallows the wheel and the page behind it sticks. The
 * region owns the scroll only while its content overflows its own box, which
 * only happens when the parent bounds it — read back from the layout, so no
 * caller has to say which case it is.
 */
export function useOwnsScroll<T extends HTMLElement>(): OwnsScroll<T> {
  const ref = useRef<T | null>(null)
  const [owns, setOwns] = useState(false)

  // After every render: a page change or a refreshed list resizes the content.
  useEffect(() => {
    const el = ref.current
    if (el === null) return undefined
    const measure = (): void => setOwns(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    if (el.firstElementChild !== null) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  })

  return { ref, owns }
}
