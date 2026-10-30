/**
 * The HUB events view — `native:reolink:hub` (D549 19).
 *
 * On a hub child the catalog is the EVENT list, not the file list: it was
 * measured faster (29 events in 293 ms against 20 files in 503 ms) and it is
 * the only class source there, because a hub child's files carry
 * `recordType none`.
 *
 * Two things this file exists to keep honest:
 *  - **an event is not a promise of a clip.** `hasRecFile` was false on 515 of
 *    1 886 rows — 27 %, not an edge case. Such a row is `playable: false` with
 *    its reason, shown and never dropped, and never offered as playable and
 *    then failing.
 *  - **`devices` is the selector, `chnbits` is inert.** `3` answered exactly
 *    what `0` did; cutting `<devices>` to one child cut 59 rows to 10. One is
 *    never derived from the other.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ReolinkClipRow } from '../clips/clip-catalog.js'
import { joinEventsToFiles, listEventRows } from '../clips/clip-event-catalog.js'

const UID = '9527000HUBCHILD0'

const event = (
  startIso: string,
  endIso: string,
  extra: { hasRecFile?: boolean; alarmTypes?: string[]; uid?: string } = {},
) => ({
  uid: extra.uid ?? UID,
  logicChn: 0,
  hasRecFile: extra.hasRecFile ?? true,
  encrypted: false,
  deleted: false,
  alarmType: (extra.alarmTypes ?? ['people']).join(','),
  alarmTypes: extra.alarmTypes ?? ['people'],
  startTime: new Date(startIso),
  endTime: new Date(endIso),
})

const fileRow = (startIso: string, endIso: string, name: string): ReolinkClipRow => ({
  clipKey: `key-${name}`,
  channel: 0,
  startMs: Date.parse(startIso),
  endMs: Date.parse(endIso),
  subFileName: `/mnt/sda/U10X-Camera N/${name}.mp4`,
  supportSub: true,
  nativeTypes: [],
})

describe('listEventRows', () => {
  it('asks ONCE for the whole window — the event list is multi-day', async () => {
    // 1 886 events over 20 days took 11.9 s in ONE call; a per-day loop would
    // pay the open/close twenty times for the same rows.
    const searchEventLog = vi.fn(async () => [
      event('2026-09-16T06:30:00Z', '2026-09-16T06:30:12Z'),
    ])
    await listEventRows(
      { searchEventLog },
      {
        uid: UID,
        channel: 0,
        timeZone: 'Europe/Rome',
        since: Date.parse('2026-09-14T00:00:00Z'),
        until: Date.parse('2026-09-17T00:00:00Z'),
      },
    )
    expect(searchEventLog).toHaveBeenCalledTimes(1)
  })

  it('names the child in `devices` and leaves chnbits alone', async () => {
    const searchEventLog = vi.fn(async () => [])
    await listEventRows(
      { searchEventLog },
      {
        uid: UID,
        channel: 0,
        timeZone: 'Europe/Rome',
        since: 1,
        until: 2,
      },
    )
    const sent = searchEventLog.mock.calls.at(0)?.at(0)
    expect(sent).toMatchObject({ devices: [{ uid: UID }] })
    // Measured inert, and never derived from `devices`.
    expect(sent).not.toHaveProperty('chnbits')
  })

  it('keeps every row of another child out of this camera’s list', async () => {
    // One hub session answers for every child it was asked about; a row for a
    // sibling must never become this camera's clip.
    const searchEventLog = vi.fn(async () => [
      event('2026-09-16T06:30:00Z', '2026-09-16T06:30:12Z'),
      event('2026-09-16T07:00:00Z', '2026-09-16T07:00:12Z', { uid: 'OTHERCHILD' }),
    ])
    const rows = await listEventRows(
      { searchEventLog },
      { uid: UID, channel: 0, timeZone: 'Europe/Rome', since: 1, until: 2 },
    )
    expect(rows).toHaveLength(1)
  })

  it('carries the raw alarm types through, all of them', async () => {
    const searchEventLog = vi.fn(async () => [
      event('2026-09-16T06:30:00Z', '2026-09-16T06:30:12Z', { alarmTypes: ['md', 'people'] }),
    ])
    const rows = await listEventRows(
      { searchEventLog },
      { uid: UID, channel: 0, timeZone: 'Europe/Rome', since: 1, until: 2 },
    )
    expect(rows[0]?.nativeTypes).toEqual(['md', 'people'])
  })

  it('marks a row with NO recording file unplayable, and keeps it', async () => {
    // 515 of 1 886 rows. Dropping them would under-report a camera's events by
    // a quarter; showing them as playable would fail on click.
    const searchEventLog = vi.fn(async () => [
      event('2026-09-16T06:30:00Z', '2026-09-16T06:30:12Z', { hasRecFile: false }),
    ])
    const rows = await listEventRows(
      { searchEventLog },
      { uid: UID, channel: 0, timeZone: 'Europe/Rome', since: 1, until: 2 },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.hasRecFile).toBe(false)
  })

  it('drops a row the hub dated with nothing rather than filing it at the epoch', async () => {
    const searchEventLog = vi.fn(async () => [
      {
        uid: UID,
        logicChn: 0,
        hasRecFile: true,
        encrypted: false,
        deleted: false,
        alarmType: 'md',
        alarmTypes: ['md'],
      },
    ])
    const rows = await listEventRows(
      { searchEventLog },
      { uid: UID, channel: 0, timeZone: 'Europe/Rome', since: 1, until: 2 },
    )
    expect(rows).toEqual([])
  })

  it('orders newest first', async () => {
    const searchEventLog = vi.fn(async () => [
      event('2026-09-16T06:00:00Z', '2026-09-16T06:00:12Z'),
      event('2026-09-16T18:00:00Z', '2026-09-16T18:00:12Z'),
    ])
    const rows = await listEventRows(
      { searchEventLog },
      { uid: UID, channel: 0, timeZone: 'Europe/Rome', since: 1, until: 2 },
    )
    expect(rows.map((r) => r.startMs)).toEqual([
      Date.parse('2026-09-16T18:00:00Z'),
      Date.parse('2026-09-16T06:00:00Z'),
    ])
  })
})

describe('joinEventsToFiles', () => {
  const file = fileRow('2026-09-16T06:29:50Z', '2026-09-16T06:31:00Z', 'RecS02_a')

  const rowFor = (startIso: string, endIso: string, hasRecFile = true) => ({
    channel: 0,
    startMs: Date.parse(startIso),
    endMs: Date.parse(endIso),
    nativeTypes: ['people'],
    hasRecFile,
  })

  it('resolves an event inside a file to that file’s byte handle', async () => {
    const joined = joinEventsToFiles(
      [rowFor('2026-09-16T06:30:00Z', '2026-09-16T06:30:12Z')],
      [file],
    )
    expect(joined[0]?.fileName).toBe('/mnt/sda/U10X-Camera N/RecS02_a.mp4')
    expect(joined[0]?.playable).toBe(true)
    expect(joined[0]?.clipKey).toBe('key-RecS02_a')
  })

  it('tolerates the ±3 s the file boundaries really drift by', async () => {
    const joined = joinEventsToFiles(
      [rowFor('2026-09-16T06:29:48Z', '2026-09-16T06:31:02Z')],
      [file],
    )
    expect(joined[0]?.playable).toBe(true)
  })

  it('marks an event that sits in NO file unplayable, with its reason', async () => {
    // Measured: 1 of 29 on 3628 day 16 — `bHasRecFile 1` and nothing coverable,
    // and the hub refused its CoverPreview too.
    const joined = joinEventsToFiles(
      [rowFor('2026-09-16T12:00:00Z', '2026-09-16T12:00:12Z')],
      [file],
    )
    expect(joined[0]?.playable).toBe(false)
    expect(joined[0]?.unplayableReason).toBe('no-file-for-window')
    expect(joined[0]?.fileName).toBeUndefined()
  })

  it('never even looks for a file when the hub said there is none', async () => {
    const joined = joinEventsToFiles(
      [rowFor('2026-09-16T06:30:00Z', '2026-09-16T06:30:12Z', false)],
      [file],
    )
    expect(joined[0]?.playable).toBe(false)
    expect(joined[0]?.unplayableReason).toBe('no-rec-file')
  })

  it('gives an unplayable row a key of its OWN, never another clip’s', async () => {
    const joined = joinEventsToFiles(
      [rowFor('2026-09-16T12:00:00Z', '2026-09-16T12:00:12Z')],
      [file],
    )
    expect(joined[0]?.clipKey).not.toBe('key-RecS02_a')
    expect(joined[0]?.clipKey).toMatch(/^[0-9a-f]{40}$/)
  })

  it('files two events of one recording under the SAME file', async () => {
    // 1–13 windows per file were measured. Two rows, one file, one thumbnail.
    const joined = joinEventsToFiles(
      [
        rowFor('2026-09-16T06:30:00Z', '2026-09-16T06:30:12Z'),
        rowFor('2026-09-16T06:30:40Z', '2026-09-16T06:30:52Z'),
      ],
      [file],
    )
    expect(joined.map((r) => r.clipKey)).toEqual(['key-RecS02_a', 'key-RecS02_a'])
  })

  it('answers every event even when the day’s file list could not be read', async () => {
    // Losing the file list costs playability, not the events.
    const joined = joinEventsToFiles([rowFor('2026-09-16T06:30:00Z', '2026-09-16T06:30:12Z')], [])
    expect(joined).toHaveLength(1)
    expect(joined[0]?.playable).toBe(false)
    expect(joined[0]?.unplayableReason).toBe('no-file-for-window')
  })
})
