/**
 * Tiny URL query sync for surfaces that cannot assume react-router
 * (federated addon pages) or that only need a handful of params.
 *
 * Reads on mount + whenever the query string changes (our writes, other
 * hook instances, react-router `setSearchParams`, back/forward). Writes
 * with `history.replaceState`. Empty / null values are deleted so the URL
 * stays short.
 *
 * Multiple `useUrlQueryParam` mounts (and a parent reading the same key via
 * this hook while a child writes) must stay in sync — otherwise a Rules
 * area pill updates `?section=` while the Notifications header still shows
 * "New rule" from a stale snapshot.
 */
import { useCallback, useEffect, useState } from 'react'

const URL_QUERY_EVENT = 'camstack:url-query'

function readParam(key: string): string | null {
  return new URLSearchParams(window.location.search).get(key)
}

function notifyUrlQuery(): void {
  window.dispatchEvent(new Event(URL_QUERY_EVENT))
}

function writeParam(key: string, value: string | null): void {
  const params = new URLSearchParams(window.location.search)
  if (value === null || value === '') params.delete(key)
  else params.set(key, value)
  const qs = params.toString()
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
  // Patched replaceState notifies every mount (see ensureHistoryPatched).
  window.history.replaceState(null, '', url)
}

/** Marks a history entry an editor was opened on, so closing it can go back instead of stacking. */
export const FORM_OPEN_STATE_KEY = 'camstackFormOpen'

/** Router-made entries keep their `state` option under `usr`. */
export const FORM_OPEN_ROUTER_STATE: { readonly camstackFormOpen: true } = {
  camstackFormOpen: true,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** True when the current history entry was pushed by an editor opening. */
export function isFormOpenEntry(): boolean {
  const state: unknown = window.history.state
  if (!isRecord(state)) return false
  if (state[FORM_OPEN_STATE_KEY] === true) return true
  const usr = state['usr']
  return isRecord(usr) && usr[FORM_OPEN_STATE_KEY] === true
}

export type UrlWriteMode = 'replace' | 'push'

/**
 * Several params in ONE history write. `push` adds an entry (marked as an
 * editor-open entry) so Back returns to the previous view; `replace` rewrites
 * the current one.
 */
export function writeUrlParams(
  changes: Readonly<Record<string, string | null>>,
  mode: UrlWriteMode,
): void {
  const params = new URLSearchParams(window.location.search)
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === '') params.delete(key)
    else params.set(key, value)
  }
  const qs = params.toString()
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
  ensureHistoryPatched()
  if (mode === 'push') window.history.pushState(FORM_OPEN_ROUTER_STATE, '', url)
  else window.history.replaceState(null, '', url)
}

let historyPatched = false

/** So react-router (and anyone else) replaceState/pushState refresh every hook. */
function ensureHistoryPatched(): void {
  if (historyPatched || typeof window === 'undefined') return
  historyPatched = true
  const originalReplace = window.history.replaceState.bind(window.history)
  const originalPush = window.history.pushState.bind(window.history)
  window.history.replaceState = (...args: Parameters<History['replaceState']>): void => {
    originalReplace(...args)
    notifyUrlQuery()
  }
  window.history.pushState = (...args: Parameters<History['pushState']>): void => {
    originalPush(...args)
    notifyUrlQuery()
  }
}

/**
 * One query param as React state. `null` means absent.
 * Changing it replaces the URL without a navigation.
 */
export function useUrlQueryParam(
  key: string,
): readonly [string | null, (next: string | null) => void] {
  ensureHistoryPatched()
  const [value, setValue] = useState<string | null>(() => readParam(key))

  useEffect(() => {
    const sync = (): void => setValue(readParam(key))
    window.addEventListener('popstate', sync)
    window.addEventListener(URL_QUERY_EVENT, sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener(URL_QUERY_EVENT, sync)
    }
  }, [key])

  const set = useCallback(
    (next: string | null): void => {
      writeParam(key, next)
      setValue(next)
    },
    [key],
  )

  return [value, set] as const
}
