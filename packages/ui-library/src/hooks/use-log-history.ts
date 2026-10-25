/**
 * useLogHistory — pages the server-served log history (D898).
 *
 * The first page and every older page go through `collectPage`, which keeps
 * calling `logs.query` with `before: nextBefore` while the server answers a
 * short, not-done slice. Changing the filters aborts whatever is in flight and
 * restarts from the first page; `cancel()` aborts the scan but keeps what was
 * found and the cursor reached, so "Load older" resumes from there.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { trpc } from '../trpc-react'
import {
  collectPage,
  type FetchLogSlice,
  type LogWireEntry,
} from '../composites/log-history-paging'

export type LogHistoryLevel = 'debug' | 'info' | 'warn' | 'error'

/** The filters the SERVER applies; everything but paging. */
export interface LogHistoryQuery {
  /** A log-destination addonId or `ring`; undefined = the server default. */
  readonly source?: string
  readonly level: LogHistoryLevel
  readonly text?: string
  readonly tags?: Record<string, string | number>
}

export type LogHistoryStatus = 'idle' | 'loading'

export interface LogHistory {
  /** Newest first, as paged. */
  readonly entries: readonly LogWireEntry[]
  readonly status: LogHistoryStatus
  /** True when nothing older exists ("Beginning of logs"). */
  readonly done: boolean
  /** Bytes scanned by the scan in flight (0 until its first slice answers). */
  readonly scannedBytes: number
  /** The source that answered (the server may fall back to `ring`). */
  readonly source: string | undefined
  readonly error: string | null
  readonly loadOlder: () => void
  readonly cancel: () => void
}

interface State {
  readonly entries: readonly LogWireEntry[]
  readonly nextBefore: string | null
  readonly done: boolean
  readonly status: LogHistoryStatus
  readonly scannedBytes: number
  readonly source: string | undefined
  readonly error: string | null
}

const INITIAL: State = {
  entries: [],
  nextBefore: null,
  done: false,
  status: 'loading',
  scannedBytes: 0,
  source: undefined,
  error: null,
}

export function useLogHistory(query: LogHistoryQuery, limit: number): LogHistory {
  const utils = trpc.useUtils()
  const [state, setState] = useState<State>(INITIAL)
  const stateRef = useRef(state)
  stateRef.current = state
  const queryRef = useRef(query)
  queryRef.current = query
  const abortRef = useRef<AbortController | null>(null)
  const queryKey = JSON.stringify(query)

  const run = useCallback(
    async (before: string | undefined, reset: boolean): Promise<void> => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setState((prev) => ({
        ...(reset ? INITIAL : prev),
        status: 'loading',
        scannedBytes: 0,
        error: null,
      }))
      const fetchSlice: FetchLogSlice = (cursor, remaining, signal) =>
        utils.client.logs.query.query(
          {
            ...queryRef.current,
            limit: remaining,
            ...(cursor !== undefined ? { before: cursor } : {}),
          },
          { signal },
        )
      try {
        const out = await collectPage({
          fetchSlice,
          limit,
          ...(before !== undefined ? { before } : {}),
          signal: controller.signal,
          onProgress: (scannedBytes) => {
            if (abortRef.current === controller) setState((prev) => ({ ...prev, scannedBytes }))
          },
        })
        // A newer run (filters changed, unmount) superseded this one.
        if (abortRef.current !== controller) return
        setState((prev) => ({
          entries: reset ? out.entries : [...prev.entries, ...out.entries],
          nextBefore: out.nextBefore,
          done: out.done,
          status: 'idle',
          scannedBytes: out.scannedBytes,
          source: out.source ?? prev.source,
          error: null,
        }))
      } catch (error: unknown) {
        if (abortRef.current !== controller) return
        setState((prev) => ({
          ...prev,
          status: 'idle',
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    },
    [utils, limit],
  )

  // Filters (or the page size) changed: abort and start again from the newest.
  useEffect(() => {
    void run(undefined, true)
    return () => {
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [run, queryKey])

  const loadOlder = useCallback(() => {
    const current = stateRef.current
    if (current.status === 'loading' || current.done) return
    void run(current.nextBefore ?? undefined, false)
  }, [run])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return {
    entries: state.entries,
    status: state.status,
    done: state.done,
    scannedBytes: state.scannedBytes,
    source: state.source,
    error: state.error,
    loadOlder,
    cancel,
  }
}
