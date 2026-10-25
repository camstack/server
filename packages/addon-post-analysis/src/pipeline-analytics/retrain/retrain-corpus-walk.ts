/**
 * Walk retrain-frame rows in {@link compareCorpusNewestFirst} order and stop
 * once a page is full.
 *
 * The records engine orders a clock page by `at` desc, `rid` desc. The corpus
 * order breaks a timestamp tie by frameId ascending, so each equal-`copiedAt`
 * group is sorted before any of it is emitted. A group that straddles a clock
 * page is finished before it is sorted — the page boundary then matches the
 * in-memory oracle, and a later page does not repeat a frame.
 *
 * One clock read asks for `offset + limit + 1` rows (capped), not the kind.
 * The extra row tells a timestamp group that it has ended.
 */
import type { EventLedgerRow } from '../store/event-ledger-collection.js'
import { compareCorpusNewestFirst } from './retrain-corpus-query.js'
import type { RetrainFrame } from './retrain-frame-store.js'

/** A clock page is never an unbounded read of the kind. */
const CLOCK_PAGE_MAX = 200

export interface CorpusWalkSource {
  readonly pageByClock: (
    cursor: string | null,
    limit: number,
    deviceId: number | undefined,
  ) => Promise<{ readonly rows: readonly EventLedgerRow[]; readonly nextCursor: string | null }>
  readonly toFrame: (id: string, data: Record<string, unknown>) => RetrainFrame
}

export interface CorpusWalkInput {
  readonly deviceIds: readonly number[] | undefined
  readonly offset: number
  readonly limit: number
  readonly keep: (frame: RetrainFrame) => boolean
}

/** Empty or omitted device ids impose no camera constraint. Duplicates collapse. */
export function corpusDeviceIds(
  deviceIds: readonly number[] | undefined,
): readonly number[] | undefined {
  if (deviceIds === undefined || deviceIds.length === 0) return undefined
  return [...new Set(deviceIds)]
}

function clockBatch(prefetch: number): number {
  const asked = prefetch < 1 ? 1 : prefetch
  return asked > CLOCK_PAGE_MAX ? CLOCK_PAGE_MAX : asked
}

class OracleStream {
  private readonly batch: number
  private readonly deviceId: number | undefined
  private readonly source: CorpusWalkSource
  private cursor: string | null = null
  private raw: readonly EventLedgerRow[] = []
  private rawIndex = 0
  private fetched = false
  private exhausted = false
  private queue: RetrainFrame[] = []
  private queueIndex = 0

  constructor(source: CorpusWalkSource, deviceId: number | undefined, batch: number) {
    this.source = source
    this.deviceId = deviceId
    this.batch = batch
  }

  async next(): Promise<RetrainFrame | null> {
    if (this.queueIndex < this.queue.length) {
      const frame = this.queue[this.queueIndex]
      this.queueIndex += 1
      return frame ?? null
    }
    const group = await this.readGroup()
    if (group.length === 0) return null
    this.queue = group.toSorted(compareCorpusNewestFirst)
    this.queueIndex = 1
    return this.queue[0] ?? null
  }

  private async readGroup(): Promise<readonly RetrainFrame[]> {
    const rows: EventLedgerRow[] = []
    let at: number | null = null
    for (;;) {
      const row = await this.peek()
      if (row === null) break
      const rowAt = Number(row.data['copiedAt'] ?? 0)
      if (at !== null && rowAt !== at) break
      at = rowAt
      this.rawIndex += 1
      rows.push(row)
    }
    return rows.flatMap((row) => {
      if (typeof row.id !== 'string') return []
      return [this.source.toFrame(row.id, row.data)]
    })
  }

  private async peek(): Promise<EventLedgerRow | null> {
    if (this.rawIndex < this.raw.length) return this.raw[this.rawIndex] ?? null
    if (this.exhausted) return null
    const page = await this.source.pageByClock(
      this.fetched ? this.cursor : null,
      this.batch,
      this.deviceId,
    )
    this.fetched = true
    this.raw = page.rows
    this.rawIndex = 0
    this.cursor = page.nextCursor
    if (page.nextCursor === null) this.exhausted = true
    if (this.raw.length === 0) return null
    return this.raw[0] ?? null
  }
}

function newestHead(heads: readonly (RetrainFrame | null)[]): number {
  let best = -1
  for (let i = 0; i < heads.length; i += 1) {
    const frame = heads[i]
    if (frame === undefined || frame === null) continue
    const current = best < 0 ? null : heads[best]
    if (current === null || current === undefined || compareCorpusNewestFirst(frame, current) < 0) {
      best = i
    }
  }
  return best
}

/** The page, in corpus order. Stops once `limit` kept frames have been taken. */
export async function takeCorpusPage(
  source: CorpusWalkSource,
  input: CorpusWalkInput,
): Promise<readonly RetrainFrame[]> {
  if (input.limit < 1) return []
  const devices = corpusDeviceIds(input.deviceIds)
  const streams = (devices ?? [undefined]).map(
    (deviceId) => new OracleStream(source, deviceId, clockBatch(input.offset + input.limit + 1)),
  )
  const heads: (RetrainFrame | null)[] = await Promise.all(streams.map((stream) => stream.next()))
  const out: RetrainFrame[] = []
  let skipped = 0
  for (;;) {
    const best = newestHead(heads)
    if (best < 0) return out
    const frame = heads[best]
    const stream = streams[best]
    if (frame === undefined || frame === null || stream === undefined) return out
    heads[best] = await stream.next()
    if (!input.keep(frame)) continue
    if (skipped < input.offset) {
      skipped += 1
      continue
    }
    out.push(frame)
    if (out.length >= input.limit) return out
  }
}
