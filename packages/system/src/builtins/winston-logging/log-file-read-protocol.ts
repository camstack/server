/**
 * Messages between `WinstonDestination` and its reader thread (D898), and the
 * one function both the thread and the in-process mode run.
 */
import type { LogReadQuery, LogReadResult } from '@camstack/types'
import type { LogFileIndexStore } from './log-file-index-store.js'
import {
  readLogFilesBackward,
  readLogFilesForward,
  type FileReadOutcome,
} from './log-file-reader.js'

export interface ReadWorkerData {
  readonly logsDir: string
  /** Period of the background index pass; 0 disables it (specs). */
  readonly backgroundPassMs: number
}

export type ToReader =
  | { readonly type: 'read'; readonly id: number; readonly query: LogReadQuery }
  | { readonly type: 'cancel'; readonly requestId: string }
  | { readonly type: 'stop' }

export type FromReader =
  | { readonly type: 'result'; readonly id: number; readonly result: LogReadResult }
  | { readonly type: 'error'; readonly id: number; readonly message: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isFromReader(value: unknown): value is FromReader {
  return (
    isObject(value) &&
    (value['type'] === 'result' || value['type'] === 'error') &&
    typeof value['id'] === 'number'
  )
}

export function isToReader(value: unknown): value is ToReader {
  if (!isObject(value)) return false
  if (value['type'] === 'stop') return true
  if (value['type'] === 'cancel') return typeof value['requestId'] === 'string'
  return value['type'] === 'read' && typeof value['id'] === 'number' && isObject(value['query'])
}

/** Requests cancelled before or while they run, with when, so the set cannot grow. */
export class CancelBook {
  private readonly at = new Map<string, number>()
  cancel(requestId: string, now: number = Date.now()): void {
    this.at.set(requestId, now)
    for (const [id, when] of this.at) if (now - when > 60_000) this.at.delete(id)
  }
  isCancelled(requestId: string | undefined): boolean {
    return requestId !== undefined && this.at.has(requestId)
  }
  settle(requestId: string | undefined): void {
    if (requestId !== undefined) this.at.delete(requestId)
  }
}

export async function serveRead(
  logsDir: string,
  store: LogFileIndexStore,
  cancels: CancelBook,
  query: LogReadQuery,
): Promise<FileReadOutcome> {
  const ctx = {
    logsDir,
    indexOf: (file: string) => store.indexOf(file),
    isCancelled: () => cancels.isCancelled(query.requestId),
  }
  try {
    const after = query.after
    return after !== undefined
      ? await readLogFilesForward(ctx, { ...query, after })
      : await readLogFilesBackward(ctx, query)
  } finally {
    cancels.settle(query.requestId)
  }
}
