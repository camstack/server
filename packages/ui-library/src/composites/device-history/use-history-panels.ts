/**
 * Saved history panels and hidden charts, in the signed-in user's ACCOUNT
 * preferences (D894): one row, namespace `admin.history-panels`, synced to
 * every device signed in as that user.
 *
 * A write is a compare-and-set on the revision it was based on; a conflict
 * re-applies the same change to the row as it now stands, once. A row this
 * client cannot read is never overwritten.
 */
import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSystem } from '../../contexts/system-context'
import {
  EMPTY_HISTORY_PANELS,
  HISTORY_PANELS_NAMESPACE,
  readHistoryPanels,
  type HistoryPanelsValue,
} from './history-selection'

export interface HistoryPanelsState {
  /** `pending` until the row answered; `error` when the read failed (never "no panels"). */
  readonly status: 'pending' | 'error' | 'ok'
  readonly value: HistoryPanelsValue
  /** False when the stored row could not be read: writing would destroy it. */
  readonly writable: boolean
  readonly update: (change: (current: HistoryPanelsValue) => HistoryPanelsValue) => Promise<void>
}

const QUERY_KEY = ['preferences', HISTORY_PANELS_NAMESPACE] as const

interface StoredRow {
  readonly value: unknown
  readonly revision: number
}

export function useHistoryPanels(): HistoryPanelsState {
  const client = useSystem().trpcClient
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async (): Promise<StoredRow | null> => {
      const r = await client.preferences.get.query({ namespaces: [HISTORY_PANELS_NAMESPACE] })
      const row = r.rows.find((x) => x.namespace === HISTORY_PANELS_NAMESPACE)
      return row === undefined ? null : { value: row.value, revision: row.revision }
    },
    staleTime: 30_000,
  })
  const row = q.data ?? null
  const parsed = readHistoryPanels(row?.value)

  const update = useCallback(
    async (change: (current: HistoryPanelsValue) => HistoryPanelsValue): Promise<void> => {
      const write = async (base: StoredRow | null, retry: boolean): Promise<void> => {
        const current = readHistoryPanels(base?.value)
        if (!current.parsed) throw new Error('history-panels: stored row is not readable')
        const next = change(current.value)
        const res = await client.preferences.put.mutate({
          namespace: HISTORY_PANELS_NAMESPACE,
          value: { ...next },
          baseRevision: base?.revision ?? 0,
        })
        if (res.status === 'saved') {
          qc.setQueryData(QUERY_KEY, { value: res.row.value, revision: res.row.revision })
          return
        }
        const fresh =
          res.current === null ? null : { value: res.current.value, revision: res.current.revision }
        qc.setQueryData(QUERY_KEY, fresh)
        if (!retry) throw new Error('history-panels: the row changed while saving')
        await write(fresh, false)
      }
      await write(row, true)
    },
    [client, qc, row],
  )

  return {
    status: q.status === 'success' ? 'ok' : q.status === 'error' ? 'error' : 'pending',
    value: q.status === 'success' ? parsed.value : EMPTY_HISTORY_PANELS,
    writable: q.status === 'success' && parsed.parsed,
    update,
  }
}
