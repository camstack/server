/**
 * The catalog reader, against fakes shaped from the captured wire
 * (`reolink-baichuan-js/test/fixtures/recordings/`).
 *
 * Three rules it exists to keep:
 *  - **the cheap question comes first**: never search a camera whose card is
 *    not mounted (640, `HddInfo mount 0, capacity 0` — D549 18);
 *  - **listing runs only on days the calendar names** (cmd 142, D549 8), and
 *    the per-day loop of the earlier plan is NOT kept as a fallback;
 *  - **a day the calendar marks and the index does not answer is
 *    `index-empty`, never "no clips"** (618, days 6–20 September).
 */
import { describe, expect, it, vi } from 'vitest'
import { listDayRows, readStorageState, readDayIndex } from '../clips/clip-catalog.js'

// ── Fakes shaped from the fixtures ────────────────────────────────────────

/** `standalone/hddinfo-102-response.xml`: one `<HddInfo>` with `mount 1`. */
const HDD_MOUNTED = {
  body: { HddInfoList: { HddInfo: { number: 0, capacity: 238, format: 1, mount: 1 } } },
}
/** 640, measured: `mount 0, capacity 0` — no SD card. */
const HDD_ABSENT = {
  body: { HddInfoList: { HddInfo: { number: 0, capacity: 0, format: 0, mount: 0 } } },
}

interface FakeFile {
  fileName: string
  startTime?: Date
  endTime?: Date
  sizeBytes?: number
  supportSub?: boolean
  recordType?: string
  id?: string
}

const file = (
  name: string,
  startIso: string,
  endIso: string,
  extra: Partial<FakeFile> = {},
): FakeFile => ({
  fileName: name,
  startTime: new Date(startIso),
  endTime: new Date(endIso),
  sizeBytes: 92_000,
  supportSub: true,
  ...extra,
})

describe('readStorageState', () => {
  it('reads a mounted card as present', async () => {
    const api = { getHddInfoList: vi.fn(async () => HDD_MOUNTED) }
    await expect(readStorageState(api)).resolves.toEqual({ state: 'present', capacityGb: 238 })
  })

  it('reads `mount 0, capacity 0` as NO STORAGE — the measured 640 case', async () => {
    const api = { getHddInfoList: vi.fn(async () => HDD_ABSENT) }
    await expect(readStorageState(api)).resolves.toEqual({ state: 'absent' })
  })

  it('finds the fields wherever the firmware nested them', async () => {
    // The declared library type and the wire disagree; the body is generic
    // parsed XML, so the reader locates the record structurally.
    const api = {
      getHddInfoList: vi.fn(async () => ({
        body: { HddInfoList: { item: [{ mount: 1, capacity: 58 }] } },
      })),
    }
    await expect(readStorageState(api)).resolves.toEqual({ state: 'present', capacityGb: 58 })
  })

  it('answers UNKNOWN when the camera said nothing about a disk', async () => {
    // A measurement that failed is not zero: "unknown" must never be served
    // as "no storage", or the provider would refuse to list a healthy card.
    const api = { getHddInfoList: vi.fn(async () => ({ body: {} })) }
    await expect(readStorageState(api)).resolves.toEqual({ state: 'unknown' })
  })

  it('answers UNKNOWN with the camera reason when the read threw', async () => {
    const api = {
      getHddInfoList: vi.fn(async () => {
        throw new Error('Baichuan request failed (responseCode 400, empty body).')
      }),
    }
    const out = await readStorageState(api)
    expect(out.state).toBe('unknown')
    expect(out).toMatchObject({ reason: expect.stringContaining('responseCode 400') })
  })
})

describe('readDayIndex', () => {
  it('asks cmd 142 once per month and keys the days it names', async () => {
    const getDayRecords = vi.fn(async () => ({
      index: 0,
      channelId: 0,
      days: [
        { day: 16, type: 'normal' },
        { day: 19, type: 'normal' },
      ],
    }))
    const days = await readDayIndex(
      { getDayRecords },
      {
        channel: 0,
        uid: 'U-CHILD',
        months: [{ year: 2026, month: 9 }],
      },
    )
    expect(days).toEqual(new Set(['2026-09-16', '2026-09-19']))
    expect(getDayRecords).toHaveBeenCalledTimes(1)
    // The uid is ALWAYS sent: cmd 142 needs it on a hub and ignores it on a
    // standalone (D549 18).
    expect(getDayRecords.mock.calls.at(0)?.at(0)).toMatchObject({ uid: 'U-CHILD', channel: 0 })
  })

  it('answers an empty set for a month with no footage', async () => {
    const getDayRecords = vi.fn(async () => ({ index: 0, channelId: 0, days: [] }))
    const days = await readDayIndex(
      { getDayRecords },
      {
        channel: 0,
        uid: 'U',
        months: [{ year: 2026, month: 8 }],
      },
    )
    expect(days.size).toBe(0)
  })

  it('walks every month the window spans', async () => {
    const getDayRecords = vi.fn(async () => ({
      index: 0,
      channelId: 0,
      days: [{ day: 1, type: 'normal' }],
    }))
    await readDayIndex(
      { getDayRecords },
      {
        channel: 0,
        uid: 'U',
        months: [
          { year: 2026, month: 9 },
          { year: 2026, month: 8 },
        ],
      },
    )
    expect(getDayRecords).toHaveBeenCalledTimes(2)
  })
})

describe('listDayRows', () => {
  const device = { channel: 0, uid: 'U-CHILD', timeZone: 'Europe/Rome' }

  it('pairs the sub and main searches into one row per recording', async () => {
    const getVideoclips = vi.fn(async ({ streamType }: { streamType?: string }) =>
      streamType === 'mainStream'
        ? [
            file('RecM02_a', '2026-09-16T06:30:02Z', '2026-09-16T06:31:14Z', {
              sizeBytes: 3_000_000,
            }),
          ]
        : [
            file('RecS02_a', '2026-09-16T06:30:00Z', '2026-09-16T06:31:12Z', {
              recordType: 'md,people',
            }),
          ],
    )
    const out = await listDayRows({ getVideoclips }, { ...device, day: '2026-09-16' })
    expect(out.rows).toHaveLength(1)
    const row = out.rows[0]
    expect(row?.subFileName).toBe('RecS02_a')
    expect(row?.mainFileName).toBe('RecM02_a')
    expect(row?.mainBytes).toBe(3_000_000)
    expect(row?.nativeTypes).toEqual(['md', 'people'])
    expect(row?.startMs).toBe(Date.parse('2026-09-16T06:30:00Z'))
  })

  it('always sends the child uid — the HUB uid addresses no catalog', async () => {
    const getVideoclips = vi.fn(async () => [])
    await listDayRows({ getVideoclips }, { ...device, day: '2026-09-16' })
    for (const call of getVideoclips.mock.calls) {
      expect(call.at(0)).toMatchObject({ uid: 'U-CHILD', channel: 0, timeZone: 'Europe/Rome' })
    }
  })

  it('searches the CAMERA-LOCAL day, not a UTC day', async () => {
    const getVideoclips = vi.fn(async () => [])
    await listDayRows({ getVideoclips }, { ...device, day: '2026-09-16' })
    // Rome is UTC+2 in September: the local day starts at 22:00 UTC the day before.
    expect(getVideoclips.mock.calls.at(0)?.at(0)).toMatchObject({
      start: new Date('2026-09-15T22:00:00.000Z'),
      end: new Date('2026-09-16T22:00:00.000Z'),
    })
  })

  it('reports a day the camera listed as EMPTY as index-empty, not as absent', async () => {
    // 618: the calendar marks the day, three listing families answer nothing.
    const getVideoclips = vi.fn(async () => [])
    const out = await listDayRows({ getVideoclips }, { ...device, day: '2026-09-16' })
    expect(out.rows).toEqual([])
    expect(out.indexEmpty).toBe(true)
  })

  it('does not call a day index-empty when it really held clips', async () => {
    const getVideoclips = vi.fn(async ({ streamType }: { streamType?: string }) =>
      streamType === 'mainStream'
        ? []
        : [file('RecS02_a', '2026-09-16T06:30:00Z', '2026-09-16T06:31:12Z')],
    )
    const out = await listDayRows({ getVideoclips }, { ...device, day: '2026-09-16' })
    expect(out.indexEmpty).toBe(false)
    expect(out.rows).toHaveLength(1)
  })

  it('still lists the SUB rows when the MAIN search refuses', async () => {
    // Losing the high-quality twin must not lose the day. 618 refuses cmd 298
    // on some days; a main refusal is the same shape.
    const getVideoclips = vi.fn(async ({ streamType }: { streamType?: string }) => {
      if (streamType === 'mainStream') throw new Error('Baichuan request failed (400)')
      return [file('RecS02_a', '2026-09-16T06:30:00Z', '2026-09-16T06:31:12Z')]
    })
    const out = await listDayRows({ getVideoclips }, { ...device, day: '2026-09-16' })
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]?.mainFileName).toBeUndefined()
    expect(out.mainSearchFailed).toContain('400')
  })

  it('propagates a SUB refusal — losing the catalog is not an empty day', async () => {
    const getVideoclips = vi.fn(async () => {
      throw new Error('camera refused')
    })
    await expect(listDayRows({ getVideoclips }, { ...device, day: '2026-09-16' })).rejects.toThrow(
      'camera refused',
    )
  })

  it('gives every row a key derived from the channel and the SUB file name', async () => {
    const getVideoclips = vi.fn(async ({ streamType }: { streamType?: string }) =>
      streamType === 'mainStream'
        ? []
        : [file('RecS02_a', '2026-09-16T06:30:00Z', '2026-09-16T06:31:12Z')],
    )
    const out = await listDayRows({ getVideoclips }, { ...device, day: '2026-09-16' })
    expect(out.rows[0]?.clipKey).toMatch(/^[0-9a-f]{40}$/)
  })

  it('prefers the full `<Id>` path as the byte handle when the camera sent one', async () => {
    // Playback is cmd 5 addressed by the full `<Id>` path, not the short name.
    const getVideoclips = vi.fn(async ({ streamType }: { streamType?: string }) =>
      streamType === 'mainStream'
        ? []
        : [
            file('RecS02_a', '2026-09-16T06:30:00Z', '2026-09-16T06:31:12Z', {
              id: '/mnt/sda/U10X-Camera N/RecS02_a.mp4',
            }),
          ],
    )
    const out = await listDayRows({ getVideoclips }, { ...device, day: '2026-09-16' })
    expect(out.rows[0]?.subFileName).toBe('/mnt/sda/U10X-Camera N/RecS02_a.mp4')
  })
})

/**
 * A recording that is STILL BEING WRITTEN (D563).
 *
 * The one name is the measured one: 592's newest row on 2026-09-20 was
 * `…_192927_000000_2B1E808_0.mp4`, whose second stamp is zeros and whose size
 * field is `0`, and whose `<endTime>` stayed frozen at 19:29:56 while the file
 * went on growing for fifteen minutes. `endMs` is kept — the mint window and
 * the byte fetch both need a bound — and the flag says what it is worth.
 *
 * Read-only re-measurement on 2026-09-20 evening: of 355 sub files and 355
 * main files on that camera's day, ZERO carried a `_000000_` segment and zero
 * carried a size of 0 or absent. The marker is rare and the AND is safe.
 */
describe('a recording still being written', () => {
  const device = { channel: 0, uid: 'U-CHILD', timeZone: 'Europe/Rome' }
  const OPEN = 'RecS03_DST20260920_192927_000000_2B1E808_0.mp4'
  const CLOSED = 'RecS03_DST20260920_192927_192956_2B1E808_F5B71.mp4'

  const rowFor = async (name: string, extra: Partial<FakeFile> = {}) => {
    const getVideoclips = vi.fn(async ({ streamType }: { streamType?: string }) =>
      streamType === 'mainStream'
        ? []
        : [file(name, '2026-09-20T17:29:27Z', '2026-09-20T17:29:56Z', extra)],
    )
    const out = await listDayRows({ getVideoclips }, { ...device, day: '2026-09-20' })
    return out.rows[0]
  }

  it('marks the open file — a `_000000_` end stamp with no size', async () => {
    expect((await rowFor(OPEN, { sizeBytes: 0 }))?.inProgress).toBe(true)
  })

  it('marks it when the camera omits the size entirely', async () => {
    expect((await rowFor(OPEN, { sizeBytes: undefined }))?.inProgress).toBe(true)
  })

  it('leaves a CLOSED file unmarked rather than absent-meaning-false', async () => {
    expect((await rowFor(CLOSED))?.inProgress).toBeUndefined()
  })

  it('does not mark a file that has real bytes, whatever its name says', async () => {
    // A recording that ends exactly at midnight is named `_000000_` and is
    // closed. The size is what separates the two, and it is required.
    expect((await rowFor(OPEN, { sizeBytes: 1_006_449 }))?.inProgress).toBeUndefined()
  })

  it('keeps `endMs` a number — the flag says what it is WORTH, it is not a hole', async () => {
    const row = await rowFor(OPEN, { sizeBytes: 0 })
    expect(row?.endMs).toBe(Date.parse('2026-09-20T17:29:56Z'))
  })
})
