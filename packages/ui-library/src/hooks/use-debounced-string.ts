/**
 * useDebouncedString — return `value` after `delay` ms have passed
 * without further changes. Resets the timer on every change.
 *
 * Useful for search inputs that should NOT push to URL state on every
 * keystroke. The DOM input stays controlled by an external `value`
 * (caller's `useState`); this hook produces a debounced derivation.
 */
import { useEffect, useState } from 'react'

export function useDebouncedString(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}
