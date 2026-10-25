/**
 * useScrolledPast — "has the operator scrolled past this point?", without the
 * caller having to know which ancestor is the scroll container.
 *
 * Attach the returned ref to a zero-height sentinel placed at the top of a list.
 * While the sentinel is on screen the operator is at the top of that list; once
 * it leaves the viewport they have scrolled into it.
 *
 * Why an IntersectionObserver rather than a scroll listener: the scroll container
 * differs by surface and by breakpoint — the page body on one screen, a card on
 * another, and the responsive layouts move it. A scroll listener has to be bound
 * to the right element, so it has to identify it; an observer against the viewport
 * does not care.
 *
 * Reports `false` where `IntersectionObserver` is unavailable (jsdom). That is the
 * safe default for the caller: "at the top" means live updates keep flowing, so a
 * missing API degrades to the old always-refresh behaviour rather than to a feed
 * that silently stops updating.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface ScrolledPast {
  /** Attach to a zero-height element at the top of the list. */
  readonly ref: (node: HTMLElement | null) => void
  /** True once the sentinel has left the viewport. */
  readonly scrolledPast: boolean
}

export function useScrolledPast(): ScrolledPast {
  const [scrolledPast, setScrolledPast] = useState(false)
  const nodeRef = useRef<HTMLElement | null>(null)
  // Bump to re-run the effect when the callback ref receives a different node,
  // which a plain ref assignment would not do.
  const [nodeVersion, setNodeVersion] = useState(0)

  const ref = useCallback((node: HTMLElement | null): void => {
    if (nodeRef.current === node) return
    nodeRef.current = node
    setNodeVersion((v) => v + 1)
  }, [])

  useEffect(() => {
    const node = nodeRef.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      setScrolledPast(false)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (entry) setScrolledPast(!entry.isIntersecting)
      },
      // A small top margin so a sentinel just under a sticky header still counts
      // as "at the top" instead of flickering as the header overlaps it.
      { rootMargin: '64px 0px 0px 0px', threshold: 0 },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [nodeVersion])

  return { ref, scrolledPast }
}
