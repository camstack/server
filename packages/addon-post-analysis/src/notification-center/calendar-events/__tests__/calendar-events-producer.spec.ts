/**
 * The calendar-events producer must hand the outbox a BATCH. Passing one row
 * at a time threw `inputs is not iterable` on every tick (2026-10-05).
 */
import { describe, expect, it, vi } from 'vitest'
import type { NcOutbox } from '../../outbox.js'
import { NcTextCatalog } from '../../text-catalog.js'
import { NcCalendarEventsProducer } from '../calendar-events-producer.js'
import type { NcCalendarEventsRule } from '../calendar-events-rule.js'
import type { NcCalendarEventsStore } from '../calendar-events-store.js'

/** The batch `NcOutbox.enqueue` takes — what the producer hands it. */
type EnqueueBatch = Parameters<NcOutbox['enqueue']>[0]

const WINDOW_END = Date.UTC(2026, 9, 5, 16, 5) // 18:05 Europe/Berlin (CEST)
const NOW = WINDOW_END + 60_000

function rule(over: Partial<NcCalendarEventsRule> = {}): NcCalendarEventsRule {
  return {
    id: 'cal-rule-1',
    name: 'Test calendars',
    enabled: true,
    schedule: {
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 1080, endMinute: 1085 }],
      timezone: 'Europe/Berlin',
    },
    calendars: ['cal-a'],
    horizonDays: 7,
    deliverEmpty: false,
    targets: [{ targetId: 'zentik-1' }],
    priority: 3,
    createdBy: 'u',
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    ...over,
  }
}

describe('NcCalendarEventsProducer', () => {
  it('enqueues the built rows as one batch — never one object at a time', async () => {
    const enqueue = vi.fn(async (_batch: EnqueueBatch) => 1)
    const markGenerated = vi.fn(async () => rule({ generatedAt: WINDOW_END }))
    const store = {
      listEnabled: () => [rule()],
      markGenerated,
    } as unknown as NcCalendarEventsStore
    const outbox = { enqueue } as unknown as NcOutbox
    const producer = new NcCalendarEventsProducer({
      store,
      outbox,
      calendars: {
        listCalendars: async () => [{ id: 'cal-a' }],
        listEvents: async () => [
          {
            id: 'e1',
            calendarId: 'cal-a',
            title: 'Rifiuti',
            startMs: NOW + 3_600_000,
            endMs: NOW + 7_200_000,
            allDay: false,
          },
        ],
      },
      texts: new NcTextCatalog({ language: 'it' }),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
      now: () => NOW,
    })

    const report = await producer.tick()
    expect(report).toEqual({ examined: 1, sent: 1, empty: 0, skipped: 0, failed: 0 })
    expect(enqueue).toHaveBeenCalledTimes(1)
    const [batch] = enqueue.mock.calls[0] ?? []
    expect(Array.isArray(batch)).toBe(true)
    expect(batch).toHaveLength(1)
    expect(batch?.[0]).toMatchObject({
      ruleId: 'cal-rule-1',
      targetId: 'zentik-1',
      recordKind: 'calendar-events',
    })
    expect(markGenerated).toHaveBeenCalledWith('cal-rule-1', WINDOW_END)
  })
})
