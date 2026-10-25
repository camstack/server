/**
 * The recorder's storage alerts are ONE row per (location, reason) episode, and a
 * location that cannot be written is CRITICAL (notification rules key on it).
 * Production raised a fresh `randomUUID()` per emit: 164 active rows in a few hours.
 */
import type { Alert, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { PlacementAlertPublisher, WriterRestartAlerts } from '../placement-alerts.js'

function harness() {
  const rows = new Map<string, Alert>()
  const logs: { level: string; msg: string; extras: unknown }[] = []
  const log =
    (level: string) =>
    (msg: string, extras?: unknown): void => {
      logs.push({ level, msg, extras })
    }
  const logger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
  let clock = 1_000
  const publisher = new PlacementAlertPublisher({
    port: {
      emit: async (alert) => void rows.set(alert.id, alert),
      update: async ({ alertId, patch }) => {
        const prev = rows.get(alertId)
        if (prev !== undefined) rows.set(alertId, { ...prev, ...patch })
      },
    },
    logger,
    sourceId: 'recorder',
    nodeId: 'hub',
    now: () => (clock += 10),
  })
  return { rows, logs, publisher }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const active = (rows: Map<string, Alert>): Alert[] =>
  [...rows.values()].filter((a) => a.status === 'active')

describe('PlacementAlertPublisher', () => {
  it('an unusable location is critical, storage category, with a stable id and episode key', async () => {
    const { rows, publisher } = harness()
    publisher.raise({ locationId: 'recordings:b', reason: 'unusable', detail: 'marker missing' })
    await settle()
    const alert = rows.get('recorder-placement:recordings:b:unusable')
    expect(alert).toBeDefined()
    expect(alert?.severity).toBe('critical')
    expect(alert?.category).toBe('storage')
    expect(alert?.status).toBe('active')
    expect(alert?.metadata?.['episodeKey']).toBe('recorder-placement:recordings:b:unusable')
    expect(alert?.metadata?.['locationId']).toBe('recordings:b')
  })

  it('50 re-emits of one condition are ONE active row, with a count and the first createdAt', async () => {
    const { rows, publisher } = harness()
    for (let i = 0; i < 50; i++) {
      publisher.raise({ locationId: 'recordings:b', reason: 'unusable', detail: 'marker missing' })
    }
    await settle()
    expect(active(rows)).toHaveLength(1)
    const alert = [...rows.values()][0]
    expect(alert?.metadata?.['count']).toBe(50)
    expect(alert?.createdAt).toBe(1_010)
    expect(alert?.updatedAt).toBeGreaterThan(alert?.createdAt ?? 0)
  })

  it('different locations / reasons are different rows', async () => {
    const { rows, publisher } = harness()
    publisher.raise({ locationId: 'a', reason: 'unusable', detail: 'x' })
    publisher.raise({ locationId: 'b', reason: 'unusable', detail: 'x' })
    publisher.raise({ locationId: 'a', reason: 'writer-restart', detail: 'x' })
    await settle()
    expect([...rows.keys()].sort()).toEqual([
      'recorder-placement:a:unusable',
      'recorder-placement:a:writer-restart',
      'recorder-placement:b:unusable',
    ])
  })

  it('writer-restart stays a warning and dedups', async () => {
    const { rows, publisher } = harness()
    for (let i = 0; i < 5; i++) {
      publisher.raise({ locationId: 'a', reason: 'writer-restart', detail: 'x' })
    }
    await settle()
    expect(active(rows)).toHaveLength(1)
    expect(active(rows)[0]?.severity).toBe('warning')
  })

  it('recovery completes the alert and logs the location; the next fault is a NEW episode', async () => {
    const { rows, logs, publisher } = harness()
    publisher.raise({ locationId: 'b', reason: 'unusable', detail: 'x' })
    publisher.raise({ locationId: 'b', reason: 'unusable', detail: 'x' })
    await settle()
    publisher.resolve('b', 'unusable')
    await settle()
    const id = 'recorder-placement:b:unusable'
    expect(rows.get(id)?.status).toBe('completed')
    expect(active(rows)).toHaveLength(0)
    expect(
      logs.some((l) => l.msg.includes('recovered') && JSON.stringify(l.extras).includes('"b"')),
    ).toBe(true)

    publisher.raise({ locationId: 'b', reason: 'unusable', detail: 'x' })
    await settle()
    expect(rows.get(id)?.status).toBe('active')
    expect(rows.get(id)?.metadata?.['count']).toBe(1)
  })

  it('resolve of a condition that never fired is a no-op', async () => {
    const { rows, publisher } = harness()
    publisher.resolve('zzz', 'unusable')
    await settle()
    expect(rows.size).toBe(0)
  })
})

describe('WriterRestartAlerts', () => {
  const move = (deviceId: number, plannedFor: string) => ({
    deviceId,
    profile: 'high' as const,
    writingTo: 'recordings:old',
    plannedFor,
  })
  const id = (loc: string): string => `recorder-placement:${loc}:writer-restart`

  it('pending -> active; plan applied or dropped -> completed; re-pending -> fresh row', async () => {
    const { rows, logs, publisher } = harness()
    const sync = new WriterRestartAlerts(publisher, {
      info: (msg: string, extras?: unknown) => logs.push({ level: 'info', msg, extras }),
    })
    sync.update([move(101, 'recordings:new'), move(616, 'recordings:new')])
    await settle()
    expect(rows.get(id('recordings:new'))?.status).toBe('active')

    // one camera landed: the location still has a pending camera -> stays active
    sync.update([move(616, 'recordings:new')])
    await settle()
    expect(rows.get(id('recordings:new'))?.status).toBe('active')
    expect(
      logs.some(
        (l) =>
          l.msg.includes('writer-restart') &&
          JSON.stringify(l.extras).includes('"deviceId":101') &&
          JSON.stringify(l.extras).includes('recordings:new'),
      ),
    ).toBe(true)

    // the plan was dropped (target drained/deleted): nothing pending -> completed
    sync.update([])
    await settle()
    expect(rows.get(id('recordings:new'))?.status).toBe('completed')
    expect(rows.get(id('recordings:new'))?.read).toBe(true)

    sync.update([move(101, 'recordings:new')])
    await settle()
    expect(rows.get(id('recordings:new'))?.status).toBe('active')
    expect(rows.get(id('recordings:new'))?.metadata?.['count']).toBe(1)
  })

  it('one alert per planned location, with its own count of cameras', async () => {
    const { rows, publisher } = harness()
    const sync = new WriterRestartAlerts(publisher, { info: () => undefined })
    sync.update([move(1, 'a'), move(2, 'b'), move(3, 'b')])
    await settle()
    expect([...rows.keys()].sort()).toEqual([id('a'), id('b')])
    sync.update([move(2, 'b'), move(3, 'b')])
    await settle()
    expect(rows.get(id('a'))?.status).toBe('completed')
    expect(rows.get(id('b'))?.status).toBe('active')
  })
})
