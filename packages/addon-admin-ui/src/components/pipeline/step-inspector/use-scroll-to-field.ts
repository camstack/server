/**
 * Bring a field into view inside the inspector body — what a search hit on a
 * field label ("face size", "person") lands on.
 */
import { useEffect } from 'react'

export function useScrollToField(domId: string | null): void {
  useEffect(() => {
    if (domId === null) return
    const el = document.getElementById(domId)
    if (el === null || typeof el.scrollIntoView !== 'function') return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [domId])
}
