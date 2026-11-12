/**
 * Row models (`heroLayout.getRowModels`, D1023) read ONCE per rendered list: the
 * list publishes the ids of the rows it draws, and every row of the list observes
 * the SAME query (one cache entry, one request) and reads its own entry. A row
 * outside a provider (or not in its ids) asks for itself.
 *
 * Each row observes the query itself rather than reading a value the provider
 * passes down: an answer then re-renders the rows that observe it directly.
 *
 * Live refresh: a row re-reads when one of its device's slices pushes, but every
 * request is throttled to one refetch per `ROW_MODEL_REFRESH_MS`, so a list of
 * chatty sensors costs one query per window, not one per push.
 */
import type { HeroRowModel } from '@camstack/types'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { useHeroLayoutGetRowModels } from '../../generated/system-hooks'
import { useHeroLiveRefresh } from '../hero-model/use-hero-live-refresh'

/** At most one row-model refetch per this window, however many slices push. */
export const ROW_MODEL_REFRESH_MS = 2_000

/** Where a row's model stands: unanswered, answered with nothing, or answered. */
export type RowModelStage =
  | { readonly status: 'pending' }
  | { readonly status: 'absent' }
  | { readonly status: 'ok'; readonly row: HeroRowModel }

export interface RowModelHandle {
  readonly stage: RowModelStage
  /** Re-read now (after a write). */
  readonly refetch: () => Promise<unknown>
}

interface RowModelsValue {
  /** The list's ids, sorted and unique: the input every row of the list asks with. */
  readonly ids: number[]
  readonly index: ReadonlyMap<number, number>
  readonly requestRefresh: () => void
}

const RowModelsContext = createContext<RowModelsValue | null>(null)

interface RowModelsQuery {
  readonly status: 'pending' | 'error' | 'success'
  readonly data?: readonly (HeroRowModel | null)[]
}

/** The stage of the `index`-th answered row of a query asked for in id order. */
function stageAt(query: RowModelsQuery, index: number): RowModelStage {
  if (query.status === 'pending') return { status: 'pending' }
  const row = query.status === 'success' ? query.data?.[index] : undefined
  return row === null || row === undefined ? { status: 'absent' } : { status: 'ok', row }
}

/** `fn` at most once per `ms`, trailing: a burst becomes one call at the end of the window. */
function useThrottled(fn: () => unknown, ms: number): () => void {
  const latest = useRef(fn)
  latest.current = fn
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )
  return useCallback(() => {
    if (timer.current !== null) return
    timer.current = setTimeout(() => {
      timer.current = null
      void latest.current()
    }, ms)
  }, [ms])
}

export interface RowModelsProviderProps {
  /** The devices the list draws now (the visible page, with their accessories). */
  readonly deviceIds: readonly number[]
  readonly children: ReactNode
}

export function RowModelsProvider({ deviceIds, children }: RowModelsProviderProps): ReactNode {
  // Keyed by the ids' VALUES: a list re-renders with a new array of the same rows.
  const key = [...new Set(deviceIds)].sort((a, b) => a - b).join(',')
  // A page with no Sensor or Control row asks nothing (and needs no tRPC client).
  if (key === '') return <>{children}</>
  return <ListRowModels idsKey={key}>{children}</ListRowModels>
}

interface ListRowModelsProps {
  /** The sorted, unique ids, comma-joined. */
  readonly idsKey: string
  readonly children: ReactNode
}

function ListRowModels({ idsKey, children }: ListRowModelsProps): ReactNode {
  const ids = useMemo(() => idsKey.split(',').map(Number), [idsKey])
  // The list's query: the same input the rows observe, so it is one cache entry.
  const { refetch } = useHeroLayoutGetRowModels({ deviceIds: ids, canActuate: true })
  const requestRefresh = useThrottled(refetch, ROW_MODEL_REFRESH_MS)
  const value = useMemo<RowModelsValue>(
    () => ({ ids, index: new Map(ids.map((id, i) => [id, i])), requestRefresh }),
    [ids, requestRefresh],
  )
  return <RowModelsContext.Provider value={value}>{children}</RowModelsContext.Provider>
}

/**
 * The row model of one device: its entry in the list's shared query when the list
 * carries it, else a query of its own. Re-read (throttled) when the device's slices push.
 */
export function useRowModel(deviceId: number): RowModelHandle {
  const list = useContext(RowModelsContext)
  const at = list?.index.get(deviceId)
  const inList = list !== null && at !== undefined
  const query = useHeroLayoutGetRowModels({
    deviceIds: inList ? list.ids : [deviceId],
    canActuate: true,
  })
  const ownRefresh = useThrottled(query.refetch, ROW_MODEL_REFRESH_MS)
  useHeroLiveRefresh(deviceId, inList ? list.requestRefresh : ownRefresh)
  return { stage: stageAt(query, inList ? at : 0), refetch: query.refetch }
}
