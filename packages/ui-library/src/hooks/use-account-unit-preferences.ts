/**
 * Unit preferences in the signed-in user's ACCOUNT preferences (D894): one
 * row, namespace `admin.units`, synced to every device signed in as that user.
 *
 * A write is a compare-and-set on the revision it was based on; a conflict
 * re-applies the same change to the row as it now stands, once. A row this
 * client cannot read is never overwritten.
 */
import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSystem } from '../contexts/system-context'
import {
  DEFAULT_UNIT_PREFERENCES,
  readUnitPreferences,
  UNIT_PREFERENCES_NAMESPACE,
  type UnitPreferences,
} from '../lib/unit-preferences'

export interface AccountUnitPreferencesState {
  /** `pending` until the row answered; `error` when the read failed (never "the default"). */
  readonly status: 'pending' | 'error' | 'ok'
  readonly value: UnitPreferences
  /** False when the stored row could not be read: writing would destroy it. */
  readonly writable: boolean
  readonly update: (change: Partial<UnitPreferences>) => Promise<void>
}

const QUERY_KEY = ['preferences', UNIT_PREFERENCES_NAMESPACE] as const

interface StoredRow {
  readonly value: unknown
  readonly revision: number
}

export function useAccountUnitPreferences(): AccountUnitPreferencesState {
  const client = useSystem().trpcClient
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async (): Promise<StoredRow | null> => {
      const r = await client.preferences.get.query({ namespaces: [UNIT_PREFERENCES_NAMESPACE] })
      const row = r.rows.find((x) => x.namespace === UNIT_PREFERENCES_NAMESPACE)
      return row === undefined ? null : { value: row.value, revision: row.revision }
    },
    staleTime: 30_000,
  })
  const row = q.data ?? null
  const parsed = readUnitPreferences(row?.value)

  const update = useCallback(
    async (change: Partial<UnitPreferences>): Promise<void> => {
      const write = async (base: StoredRow | null, retry: boolean): Promise<void> => {
        const current = readUnitPreferences(base?.value)
        if (!current.parsed) throw new Error('unit-preferences: stored row is not readable')
        const next: UnitPreferences = { ...current.value, ...change }
        const res = await client.preferences.put.mutate({
          namespace: UNIT_PREFERENCES_NAMESPACE,
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
        if (!retry) throw new Error('unit-preferences: the row changed while saving')
        await write(fresh, false)
      }
      await write(row, true)
    },
    [client, qc, row],
  )

  return {
    status: q.status === 'success' ? 'ok' : q.status === 'error' ? 'error' : 'pending',
    value: q.status === 'success' ? parsed.value : DEFAULT_UNIT_PREFERENCES,
    writable: q.status === 'success' && parsed.parsed,
    update,
  }
}
