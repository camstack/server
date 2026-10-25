/**
 * The slice of the settings door device-history uses. A `Pick` of the
 * generated client, never a hand-written interface (a hand-written copy keeps
 * compiling after a method is removed and fails at runtime).
 */
import type { SettingsStoreClient } from '@camstack/types'

export type HistoryDoor = Pick<
  SettingsStoreClient,
  | 'declareCollection'
  | 'query'
  | 'insert'
  | 'upsertMany'
  | 'transact'
  | 'deleteWhere'
  | 'update'
  | 'count'
  | 'delete'
>
