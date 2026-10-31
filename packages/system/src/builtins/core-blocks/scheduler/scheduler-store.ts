/**
 * Durable storage for schedulers (D983) and for how far the engine has
 * processed each one. Both are `core-blocks` record kinds.
 *
 * @durable class=config owner=core-blocks
 *   write="the operator creates / edits / deletes / switches a scheduler; the engine advances its processed-until stamp"
 *   retention="operator delete only; the stamp goes with its scheduler"
 */
import { randomUUID } from 'node:crypto'
import {
  type RecordKindHandle,
  type Scheduler,
  SchedulerError,
  type SchedulerInput,
} from '@camstack/types'
import type { SchedulerRowBody, SchedulerStateRowBody } from '../record-kinds.js'

export interface SchedulersStoreOptions {
  readonly schedulers: RecordKindHandle<SchedulerRowBody>
  readonly state: RecordKindHandle<SchedulerStateRowBody>
  readonly now?: () => number
  readonly newId?: () => string
}

export class SchedulersStore {
  private readonly schedulers: RecordKindHandle<SchedulerRowBody>
  private readonly state: RecordKindHandle<SchedulerStateRowBody>
  private readonly now: () => number
  private readonly newId: () => string

  constructor(options: SchedulersStoreOptions) {
    this.schedulers = options.schedulers
    this.state = options.state
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? randomUUID
  }

  private static of(id: string, body: SchedulerRowBody): Scheduler {
    return { ...body, id }
  }

  async list(): Promise<Scheduler[]> {
    const out: Scheduler[] = []
    let cursor: string | undefined
    do {
      const page = await this.schedulers.query(cursor === undefined ? {} : { cursor })
      for (const row of page.records) out.push(SchedulersStore.of(row.id, row.data))
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    // Stable order: the engine and the editor list in creation order.
    return out.toSorted((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  async get(schedulerId: string): Promise<Scheduler | null> {
    const row = await this.schedulers.get(schedulerId)
    return row === null ? null : SchedulersStore.of(row.id, row.data)
  }

  async create(input: SchedulerInput): Promise<Scheduler> {
    const id = this.newId()
    const at = this.now()
    const body: SchedulerRowBody = { ...input, createdAt: at, updatedAt: at }
    await this.schedulers.put({ id, data: body })
    // A new scheduler never replays the past.
    await this.setProcessedUntil(id, at)
    return SchedulersStore.of(id, body)
  }

  async update(schedulerId: string, input: SchedulerInput): Promise<Scheduler> {
    const existing = await this.schedulers.get(schedulerId)
    if (existing === null) throw new SchedulerError('not-found', `no scheduler "${schedulerId}"`)
    const at = this.now()
    const body: SchedulerRowBody = {
      ...input,
      createdAt: existing.data.createdAt,
      updatedAt: at,
    }
    await this.schedulers.put({ id: existing.id, data: body })
    // An edit never replays the past either: points before now belong to the old timeline.
    await this.setProcessedUntil(existing.id, at)
    return SchedulersStore.of(existing.id, body)
  }

  async delete(schedulerId: string): Promise<boolean> {
    const removed = await this.schedulers.delete(schedulerId)
    if (removed) await this.state.delete(schedulerId)
    return removed
  }

  async processedUntil(schedulerId: string): Promise<number | null> {
    const row = await this.state.get(schedulerId)
    return row === null ? null : row.data.processedUntil
  }

  async setProcessedUntil(schedulerId: string, at: number): Promise<void> {
    await this.state.put({ id: schedulerId, data: { processedUntil: at } })
  }
}
