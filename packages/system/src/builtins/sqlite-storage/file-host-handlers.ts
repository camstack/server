/**
 * What a thread does with a request once it has one — shared by the main
 * thread (which serves `camstack.db` in place) and the file-host worker (which
 * serves `events.db` / `history.db`), so the two cannot disagree about what an
 * op means.
 */
import type { IVectorStoreProvider } from '@camstack/types'
import {
  type ControlOp,
  type ControlOps,
  type DataStoreInput,
  type DataStoreOp,
  type DataStoreOutput,
  type VectorInput,
  type VectorOp,
  type VectorOutput,
} from './file-host-protocol.js'
import type {
  RecordsEngineOps,
  RecordsInput,
  RecordsOp,
  RecordsOutput,
} from './records/records-engine-types.js'
import type { SqliteSettingsBackend } from './sqlite-settings-backend.js'

/** The data surface as a mapped type — what lets `target[op](input)` type-check for a generic `op`. */
export type DataTarget = {
  readonly [K in DataStoreOp]: (input: DataStoreInput<K>) => Promise<DataStoreOutput<K>>
}

export type VectorTarget = {
  readonly [K in VectorOp]: (input: VectorInput<K>) => Promise<VectorOutput<K>>
}

export function callData<K extends DataStoreOp>(
  target: DataTarget,
  op: K,
  input: DataStoreInput<K>,
): Promise<DataStoreOutput<K>> {
  return target[op](input)
}

export function callVector<K extends VectorOp>(
  target: IVectorStoreProvider,
  op: K,
  input: VectorInput<K>,
): Promise<VectorOutput<K>> {
  const typed: VectorTarget = target
  return typed[op](input)
}

/** The records surface as a mapped type, for the same reason. */
export type RecordsTarget = {
  readonly [K in RecordsOp]: (input: RecordsInput<K>) => Promise<RecordsOutput<K>>
}

export function callRecords<K extends RecordsOp>(
  target: RecordsEngineOps,
  op: K,
  input: RecordsInput<K>,
): Promise<RecordsOutput<K>> {
  const typed: RecordsTarget = target
  return typed[op](input)
}

/** The control surface as a mapped type, for the same reason. */
type ControlTarget = {
  readonly [K in ControlOp]: (input: ControlOps[K]['input']) => ControlOps[K]['output']
}

/**
 * The control answers a backend can give. `threadId` is supplied by the
 * caller: only the thread knows its own.
 */
export function controlTargetOf(backend: SqliteSettingsBackend, threadId: number): ControlTarget {
  return {
    hasTable: ({ name }) => backend.hasTable(name),
    threadId: () => threadId,
    listPhysicalTables: ({ ownerPrefix }) => backend.listTables(ownerPrefix),
  }
}

export function callControl<K extends ControlOp>(
  target: ControlTarget,
  op: K,
  input: ControlOps[K]['input'],
): ControlOps[K]['output'] {
  return target[op](input)
}
