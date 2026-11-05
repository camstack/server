/**
 * useRowOperations — the per-row "an operation is in flight" state of a table.
 *
 * A row whose destructive action was confirmed stays on screen until the work
 * behind it has really finished. This hook is the ONE place that tracks that:
 * every key (a device id, a row id) is `pending` from the moment its task
 * starts until the task settles, and a task that throws leaves the key
 * `failed` with the message, so the row can show it and be retried.
 *
 * Keys are independent: two rows run concurrently, each with its own state,
 * and a second `run` for a key already pending is refused rather than doubled.
 *
 * It decides nothing about WHEN the work is done — the `task` handed to `run`
 * must resolve only after the completion signal (never after a timer).
 */
import { useCallback, useMemo, useRef, useState } from 'react'

export type RowOperationState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed'; readonly message: string }

export interface UseRowOperationsResult<K> {
  /** Every row with a state — absent keys are idle. */
  readonly states: ReadonlyMap<K, RowOperationState>
  readonly stateOf: (key: K) => RowOperationState | undefined
  readonly isPending: (key: K) => boolean
  /**
   * Run `task` for `key`. Resolves `true` when it completed, `false` when it
   * threw or when `key` was already pending (nothing was started). A failure
   * is reported to `onError` and kept as the key's `failed` state.
   */
  readonly run: (
    key: K,
    task: () => Promise<unknown>,
    onError?: (message: string) => void,
  ) => Promise<boolean>
  /** Forget a key's failure (the row goes back to idle). */
  readonly clearFailure: (key: K) => void
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return typeof error === 'string' && error.trim() !== '' ? error : 'Unknown error'
}

export function useRowOperations<K>(): UseRowOperationsResult<K> {
  const [states, setStates] = useState<ReadonlyMap<K, RowOperationState>>(() => new Map())
  // The in-flight guard is a ref: two clicks in one tick must not both start,
  // and state would only reflect the first after the next render.
  const inFlight = useRef<Set<K>>(new Set())

  const setState = useCallback((key: K, next: RowOperationState | null): void => {
    setStates((prev) => {
      const copy = new Map(prev)
      if (next === null) copy.delete(key)
      else copy.set(key, next)
      return copy
    })
  }, [])

  const run = useCallback(
    async (
      key: K,
      task: () => Promise<unknown>,
      onError?: (message: string) => void,
    ): Promise<boolean> => {
      if (inFlight.current.has(key)) return false
      inFlight.current.add(key)
      setState(key, { kind: 'pending' })
      try {
        await task()
        setState(key, null)
        return true
      } catch (error) {
        const message = errorMessageOf(error)
        setState(key, { kind: 'failed', message })
        onError?.(message)
        return false
      } finally {
        inFlight.current.delete(key)
      }
    },
    [setState],
  )

  const stateOf = useCallback((key: K) => states.get(key), [states])
  const isPending = useCallback((key: K) => states.get(key)?.kind === 'pending', [states])
  const clearFailure = useCallback((key: K): void => {
    setStates((prev) => {
      if (prev.get(key)?.kind !== 'failed') return prev
      const copy = new Map(prev)
      copy.delete(key)
      return copy
    })
  }, [])

  return useMemo(
    () => ({ states, stateOf, isPending, run, clearFailure }),
    [states, stateOf, isPending, run, clearFailure],
  )
}
