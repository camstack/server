/**
 * A vanilla-tRPC query as React state, with the three answers kept apart:
 * `pending` (no answer yet), `ok` and `error`. A list that has not answered is
 * never drawn as empty (D315) — the components read `status`, not `data ?? []`.
 */
import { type DependencyList, useCallback, useEffect, useRef, useState } from 'react'

export type AsyncState<T> =
  | { readonly status: 'pending' }
  | { readonly status: 'ok'; readonly data: T }
  | { readonly status: 'error'; readonly error: string }

export interface AsyncHandle<T> {
  readonly state: AsyncState<T>
  readonly reload: () => void
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Run `load` on mount, on `deps` change, on `reload()`, and every `pollMs` while `poll` holds. */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: DependencyList,
  options: { readonly pollMs?: number; readonly poll?: (data: T) => boolean } = {},
): AsyncHandle<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'pending' })
  const [tick, setTick] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load
  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    let alive = true
    loadRef
      .current()
      .then((data) => {
        if (alive) setState({ status: 'ok', data })
      })
      .catch((err: unknown) => {
        if (alive) setState({ status: 'error', error: errorText(err) })
      })
    return () => {
      alive = false
    }
  }, [...deps, tick])

  const { pollMs, poll } = options
  useEffect(() => {
    if (pollMs === undefined || state.status !== 'ok' || poll?.(state.data) === false) return
    const timer = setTimeout(reload, pollMs)
    return () => clearTimeout(timer)
  }, [state, pollMs, poll, reload])

  return { state, reload }
}
