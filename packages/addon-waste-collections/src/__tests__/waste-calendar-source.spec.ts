import { describe, expect, it } from 'vitest'
import { collectionsToEvents, createWasteCalendarSource } from '../waste-calendar-source.js'
import type { WasteCollectionEntry, WasteSourceConfig } from '../waste-types.js'

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as never

describe('collectionsToEvents', () => {
  const entries: readonly WasteCollectionEntry[] = [
    { date: '2026-10-15', type: 'Residual' },
    { date: '2026-10-16', type: 'Paper' },
  ]

  it('emits all-day events whose endMs is the next UTC midnight', () => {
    const events = collectionsToEvents('home', entries, {
      startMs: Date.UTC(2026, 9, 1),
      endMs: Date.UTC(2026, 9, 31),
    })
    expect(events).toHaveLength(2)
    const residual = events.find((e) => e.title === 'Residual')
    expect(residual).toBeDefined()
    expect(residual!.allDay).toBe(true)
    expect(residual!.startMs).toBe(Date.UTC(2026, 9, 15))
    expect(residual!.endMs).toBe(Date.UTC(2026, 9, 16))
    expect(residual!.calendarId).toBe('home')
  })

  it('drops entries outside the requested range', () => {
    const events = collectionsToEvents('home', entries, {
      startMs: Date.UTC(2026, 9, 16),
      endMs: Date.UTC(2026, 9, 17),
    })
    expect(events.map((e) => e.title)).toEqual(['Paper'])
  })
})

describe('createWasteCalendarSource', () => {
  const sources: WasteSourceConfig[] = [
    {
      id: 'a',
      label: 'Home',
      module: 'ics',
      args: { url: 'https://example.com/a.ics' },
      enabled: true,
    },
    {
      id: 'b',
      label: 'Off',
      module: 'static',
      args: {},
      enabled: false,
    },
  ]
  const cache = new Map<string, readonly WasteCollectionEntry[]>([
    ['a', [{ date: '2026-10-20', type: 'Bio' }]],
  ])

  it('lists only enabled sources as addon calendars', async () => {
    const provider = createWasteCalendarSource({
      logger,
      listConfigured: () => sources,
      getEntries: (id) => cache.get(id) ?? [],
    })
    const list = await provider.listCalendars()
    expect(list).toEqual([{ id: 'a', name: 'Home', source: 'addon', enabled: true }])
  })

  it('filters listEvents by calendarIds', async () => {
    const provider = createWasteCalendarSource({
      logger,
      listConfigured: () => sources,
      getEntries: (id) => cache.get(id) ?? [],
    })
    const none = await provider.listEvents({
      calendarIds: ['missing'],
      startMs: Date.UTC(2026, 9, 1),
      endMs: Date.UTC(2026, 10, 1),
    })
    expect(none).toEqual([])
    const hit = await provider.listEvents({
      calendarIds: ['a'],
      startMs: Date.UTC(2026, 9, 1),
      endMs: Date.UTC(2026, 10, 1),
    })
    expect(hit).toHaveLength(1)
    expect(hit[0]!.title).toBe('Bio')
  })
})
