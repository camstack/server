import { useEffect } from 'react'

/**
 * Locks `document.body` scroll while the component is mounted (or while
 * `active` is `true`). Saves and restores the original `overflow` value so
 * concurrent lock/unlock cycles (e.g. nested modals) compose correctly.
 *
 * Mobile fix: prevents scroll chaining from a modal's inner scroll container
 * onto the page underneath on iOS/Android. Works in tandem with
 * `overscroll-behavior: contain` on the modal's scrollable child.
 */
export function useBodyScrollLock(active = true): void {
  useEffect(() => {
    if (!active) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [active])
}
