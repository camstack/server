/**
 * D898 — `logs.query`'s page: the source's page merged with the hub tail.
 */
import { describe, expect, it } from 'vitest'
import type { ILogDestination, LogEntry, LogReadQuery, LogReadResult } from '@camstack/types'
import { readLogHistory, RING_LOG_SOURCE } from '../log-history'

const T = Date.parse('2026-10-21T10:00:00.000Z')

function entry(id: string, at: number, extra: Partial<LogEntry> = {}): LogEntry {
  return { id, timestamp: new Date(at), level: 'info', message: `m ${id}`, ...extra }
}

function source(page: Partial<LogReadResult>, seen: LogReadQuery[] = []): ILogDestination {
  return {
    initialize: async () => undefined,
    shutdown: async () => undefined,
    write: () => undefined,
    read: async (query) => {
      seen.push(query)
      return {
        entries: [],
        nextBefore: null,
        nextAfter: null,
        scannedBytes: 0,
        done: true,
        ...page,
      }
    },
  }
}

describe('readLogHistory', () => {
  it('first page: the source page plus the unflushed tail lines, deduped by id', async () => {
    const tail = [entry('b.3', T + 3), entry('b.2', T + 2), entry('b.1', T + 1)]
    const page = await readLogHistory({
      query: { limit: 10 },
      source: 'winston-logging',
      tail,
      provider: source({
        entries: [
          { id: 'b.2', timestamp: T + 2, level: 'info', message: 'm b.2' },
          { id: 'b.1', timestamp: T + 1, level: 'info', message: 'm b.1' },
        ],
        nextBefore: 'cursor-1',
        done: false,
      }),
    })
    expect(page.entries.map((e) => e.id)).toEqual(['b.3', 'b.2', 'b.1'])
    expect(page.nextBefore).toBe('cursor-1')
    expect(page.source).toBe('winston-logging')
  })

  it('applies the filter to the tail too', async () => {
    const tail = [
      entry('d.2', T + 2, { tags: { deviceId: 101 }, level: 'warn' }),
      entry('d.1', T + 1, { tags: { deviceId: 1 } }),
    ]
    const page = await readLogHistory({
      query: { deviceId: 101, limit: 10 },
      source: 'winston-logging',
      tail,
      provider: source({}),
    })
    expect(page.entries.map((e) => e.id)).toEqual(['d.2'])
  })

  it('a cursor page is the source alone — the tail is never repeated', async () => {
    const seen: LogReadQuery[] = []
    const page = await readLogHistory({
      query: { before: 'cursor-1', limit: 5 },
      source: 'winston-logging',
      tail: [entry('t.1', T)],
      provider: source({ entries: [] }, seen),
    })
    expect(page.entries).toEqual([])
    expect(seen[0]?.before).toBe('cursor-1')
  })

  it('no readable source ⇒ the tail, answered as `ring`', async () => {
    const page = await readLogHistory({
      query: { limit: 1 },
      source: 'winston-logging',
      tail: [entry('t.2', T + 2), entry('t.1', T + 1)],
      provider: null,
    })
    expect(page.source).toBe(RING_LOG_SOURCE)
    expect(page.entries.map((e) => e.id)).toEqual(['t.2'])
    expect(page.done).toBe(true)
  })
})
