/**
 * Usage store over the `usage` record kind (spec §6). One row per LLM call; the
 * call time is the record's `at`, and the engine ages rows out 90 days after it
 * (`USAGE_RETENTION_MS`) — nothing here prunes. Query-then-group in JS is
 * deliberate: LLM call volume is low and the table is bounded by that TTL.
 */
import { randomUUID } from 'node:crypto'
import type {
  IScopedLogger,
  LlmUsageRollup,
  RecordKindHandle,
  RecordsAccess,
} from '@camstack/types'
import { aiRecordKinds, UsageBodySchema, type UsageBody } from '../record-kinds.js'
import { readAllRows } from '../record-pages.js'
import type { UsageFilter, UsageRecorder, UsageRowInput } from './usage-port.js'

/** Legacy collection name — kept for the adoption mapper / docs. */
export const USAGE_COLLECTION = 'ai:usage'

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

interface RollupAcc {
  day: string
  consumer: string
  profileId: string
  calls: number
  okCalls: number
  errorCalls: number
  inputTokens: number
  outputTokens: number
  latencySum: number
}

/** A usage row read back: the body plus the call time the record carries as `at`. */
interface UsageRow extends UsageBody {
  readonly ts: number
}

export class UsageStore implements UsageRecorder {
  constructor(
    private readonly kind: RecordKindHandle<UsageBody>,
    private readonly logger?: IScopedLogger,
  ) {}

  static of(records: Pick<RecordsAccess, 'kind'>, logger?: IScopedLogger): UsageStore {
    return new UsageStore(records.kind(aiRecordKinds.usage), logger)
  }

  async record(row: UsageRowInput): Promise<void> {
    const { ts, ...body } = row
    await this.kind.put({ id: randomUUID(), at: ts, data: body })
  }

  private async validRows(filter: UsageFilter): Promise<UsageRow[]> {
    const rows = await readAllRows(this.kind, {
      order: 'at',
      ...(filter.since === undefined ? {} : { atFrom: filter.since }),
      ...(filter.until === undefined ? {} : { atTo: filter.until }),
    })
    const out: UsageRow[] = []
    let dropped = 0
    let firstError = ''
    for (const row of rows) {
      const parsed = UsageBodySchema.safeParse(row.data)
      if (parsed.success && row.at !== null) {
        out.push({ ...parsed.data, ts: row.at })
        continue
      }
      dropped += 1
      if (firstError === '') {
        firstError = parsed.success ? 'no at' : (parsed.error.issues[0]?.message ?? 'unparseable')
      }
    }
    // A rollup that silently discards rows reports "no usage" for a hub that
    // billed calls all day. Say how many and why, once per read.
    if (dropped > 0) {
      this.logger?.warn('usage rollup discarded unparseable rows', {
        meta: { dropped, kept: out.length, firstError },
      })
    }
    return out
  }

  async rollup(filter: UsageFilter): Promise<LlmUsageRollup[]> {
    const rows = (await this.validRows(filter)).filter((r) => {
      if (filter.consumer !== undefined && r.consumer !== filter.consumer) return false
      if (filter.profileId !== undefined && (r.profileId ?? '') !== filter.profileId) return false
      return true
    })

    const groups = new Map<string, RollupAcc>()
    for (const r of rows) {
      const profileId = r.profileId ?? ''
      const day = dayKey(r.ts)
      const key = `${day}|${r.consumer}|${profileId}`
      const acc = groups.get(key) ?? {
        day,
        consumer: r.consumer,
        profileId,
        calls: 0,
        okCalls: 0,
        errorCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencySum: 0,
      }
      acc.calls += 1
      if (r.ok) acc.okCalls += 1
      else acc.errorCalls += 1
      acc.inputTokens += r.inputTokens
      acc.outputTokens += r.outputTokens
      acc.latencySum += r.latencyMs
      groups.set(key, acc)
    }

    return [...groups.values()]
      .map(
        (acc): LlmUsageRollup => ({
          day: acc.day,
          consumer: acc.consumer,
          profileId: acc.profileId,
          calls: acc.calls,
          okCalls: acc.okCalls,
          errorCalls: acc.errorCalls,
          inputTokens: acc.inputTokens,
          outputTokens: acc.outputTokens,
          avgLatencyMs: acc.calls > 0 ? acc.latencySum / acc.calls : 0,
        }),
      )
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  }
}
