import { type RefObject } from 'react'
import { useHotkey } from './hotkey-provider'

export interface UseSearchFieldHotkeyOptions {
  /** Pass false to leave the browser's find alone for this field. Default true. */
  readonly enabled?: boolean
  /** Only the app-level search passes `FALLBACK_SCOPE`: it yields to any field on the page. */
  readonly scope?: string
}

function isReachable(el: HTMLInputElement): boolean {
  return el.isConnected && !el.disabled && el.getClientRects().length > 0
}

/**
 * Register a search field: ⌘F / Ctrl+F and ⌘K / Ctrl+K focus and select it.
 * A field that is hidden or disabled declines, so the browser's find still runs.
 * The library's search inputs call this themselves.
 */
export function useSearchFieldHotkey(
  ref: RefObject<HTMLInputElement | null>,
  options: UseSearchFieldHotkeyOptions = {},
): void {
  const enabled = options.enabled ?? true
  const scope = options.scope
  const focusField = (): boolean => {
    const el = ref.current
    if (!el || !isReachable(el)) return false
    el.focus()
    el.select()
    return true
  }
  useHotkey('mod+f', focusField, { enabled, scope })
  useHotkey('mod+k', focusField, { enabled, scope })
}
