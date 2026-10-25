/**
 * The ops one database file serves for `records` (D881): the `records` cap's
 * methods with an explicit `owner` (the transport-stamped caller, decided by
 * the router) plus the engine's own housekeeping. Pure types: the worker bundle
 * and the main thread both import this.
 */
import type { IRecordsProvider, StorageKind } from '@camstack/types'

/** A `records` cap method's input with the owner the router resolved. */
export type OwnedInput<M extends keyof IRecordsProvider> = Parameters<IRecordsProvider[M]>[0] & {
  readonly owner: string
}

type OwnedOps = {
  readonly [M in keyof IRecordsProvider]: (
    input: OwnedInput<M>,
  ) => Promise<Awaited<ReturnType<IRecordsProvider[M]>>>
}

export interface RecordsEngineOps extends OwnedOps {
  /** Every kind this file holds, with rows and a size estimate (System -> Data). */
  listKinds(input: {
    readonly owner?: string | undefined
    readonly counts?: boolean | undefined
  }): Promise<readonly StorageKind[]>
  /** Delete rows past `expires_at`, in batches. */
  sweepExpired(input: { readonly batch?: number }): Promise<{ readonly deleted: number }>
}

export type RecordsOp = keyof RecordsEngineOps
export type RecordsInput<K extends RecordsOp> = Parameters<RecordsEngineOps[K]>[0]
export type RecordsOutput<K extends RecordsOp> = Awaited<ReturnType<RecordsEngineOps[K]>>

export const RECORDS_OPS: readonly RecordsOp[] = [
  'declareKinds',
  'get',
  'getMany',
  'secretRefs',
  'put',
  'putMany',
  'patch',
  'delete',
  'deleteMany',
  'query',
  'count',
  'histogram',
  'aggregate',
  'deleteWhere',
  'transact',
  'deleteDevice',
  'allocateId',
  'listKinds',
  'sweepExpired',
]

export function isRecordsOp(op: string): op is RecordsOp {
  return RECORDS_OPS.some((known) => known === op)
}
