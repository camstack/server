import { describe, expect, it, vi } from 'vitest'
import {
  alarmOpeningFrom,
  alarmOpeningFromSensorEvent,
  classifyCoveredOpening,
  rawForLog,
  readAlarmOpenings,
} from '../alarm-openings.js'

describe('alarmOpeningFrom — D630 table', () => {
  it.each([
    [{ contact: { entryOpen: true } }, 'open', 'open'],
    [{ contact: { entryOpen: false } }, 'secure', 'closed'],
    [{ cover: { state: 'closed', position: 0 } }, 'secure', 'closed'],
    [{ cover: { state: 'open', position: 100 } }, 'open', 'open'],
    [{ cover: { state: 'opening', position: 30 } }, 'open', 'opening'],
    [{ cover: { state: 'stopped', position: 40 } }, 'open', 'stopped'],
    [{ cover: { state: 'closing', position: 10 } }, 'open', 'closing'],
    [{ 'lock-control': { state: 'locked' } }, 'secure', 'locked'],
    [{ 'lock-control': { state: 'unlocked' } }, 'open', 'unlocked'],
    [{ 'lock-control': { state: 'unlocking' } }, 'open', 'unlocking'],
    [{ 'lock-control': { state: 'jammed' } }, 'open', 'jammed'],
    [{ 'lock-control': { state: 'locking' } }, 'open', 'locking'],
  ])('%j → %s', (runtime, reading, state) => {
    expect(alarmOpeningFrom(runtime)).toMatchObject({ kind: 'reading', reading, state })
  })

  it('a camera is not an opening; a switch on/off is', () => {
    expect(alarmOpeningFrom({ switch: { on: true } })).toMatchObject({
      kind: 'reading',
      reading: 'open',
      state: 'on',
      cap: 'switch',
    })
    expect(alarmOpeningFrom({ switch: { on: false } })).toMatchObject({
      kind: 'reading',
      reading: 'secure',
      state: 'off',
      cap: 'switch',
    })
    expect(alarmOpeningFrom({ 'device-status': { online: true } })).toEqual({
      kind: 'not-opening',
    })
    expect(alarmOpeningFrom({})).toEqual({ kind: 'not-opening' })
  })

  it('an unrecognised word is UNKNOWN — not guessed, and not "not an opening" (D49)', () => {
    expect(alarmOpeningFrom({ cover: { state: 'weird' } })).toEqual({
      kind: 'unknown',
      cap: 'cover',
      raw: 'weird',
    })
    expect(alarmOpeningFrom({ 'lock-control': { state: 3 } })).toEqual({
      kind: 'unknown',
      cap: 'lock-control',
      raw: 3,
    })
  })

  it('an opening slice with its field missing is UNKNOWN', () => {
    expect(alarmOpeningFrom({ cover: {} })).toEqual({
      kind: 'unknown',
      cap: 'cover',
      raw: undefined,
    })
    expect(alarmOpeningFrom({ contact: {} })).toEqual({
      kind: 'unknown',
      cap: 'contact',
      raw: undefined,
    })
  })

  // C1 (alarm Phase 2 review): provider constructors write a cold placeholder
  // (`lastChangedAt: 0`) before they have read the device. Read as a state, an
  // HA lock's placeholder `unlocked` is an open lock, and a placeholder
  // `closed` / `entryOpen: false` is a secure opening — the reconcile tick, the
  // arm check and the exclusion lift would each act on a guess.
  it.each([
    ['contact', { entryOpen: false, lastChangedAt: 0 }],
    ['cover', { state: 'closed', position: 0, tiltPosition: null, lastChangedAt: 0 }],
    ['lock-control', { state: 'unlocked', lastChangedAt: 0 }],
  ])('a %s PLACEHOLDER slice (lastChangedAt 0) is UNKNOWN, never a state (D49)', (cap, slice) => {
    expect(alarmOpeningFrom({ [cap]: slice })).toEqual({ kind: 'unknown', cap, raw: slice })
    expect(classifyCoveredOpening(alarmOpeningFrom({ [cap]: slice }))).toMatchObject({
      kind: 'unknown',
    })
  })

  // A value a provider REPLAYED after a respawn is known, its change time is
  // not: it is stamped `1` (Homematic `HM_SEEDED_CHANGED_AT`), not 0. It must
  // read as the reading it is — an arm check has to block on a lock that is
  // really unlocked — while the transition gate refuses it as a fresh event.
  it.each([
    ['lock-control', { state: 'unlocked', lastChangedAt: 1 }, 'unlocked'],
    ['cover', { state: 'open', position: 100, tiltPosition: null, lastChangedAt: 1 }, 'open'],
    ['contact', { entryOpen: true, lastChangedAt: 1 }, 'open'],
  ])('a %s slice stamped known-but-old (1) is a READING, open', (cap, slice, state) => {
    expect(alarmOpeningFrom({ [cap]: slice })).toMatchObject({
      kind: 'reading',
      reading: 'open',
      state,
    })
    expect(classifyCoveredOpening(alarmOpeningFrom({ [cap]: slice }))).toMatchObject({
      kind: 'open',
      state,
    })
  })

  it('a placeholder falls through to a real slice on the same device', () => {
    expect(
      alarmOpeningFrom({
        contact: { entryOpen: false, lastChangedAt: 0 },
        cover: { state: 'open', lastChangedAt: 1_788_000_000_000 },
      }),
    ).toMatchObject({ kind: 'reading', reading: 'open', state: 'open' })
  })

  it('a placeholder sensor row reads unknown, so it moves no exclusion', () => {
    expect(alarmOpeningFromSensorEvent('lock', { state: 'unlocked', lastChangedAt: 0 }).kind).toBe(
      'unknown',
    )
    expect(alarmOpeningFromSensorEvent('contact', { entryOpen: true, lastChangedAt: 0 }).kind).toBe(
      'unknown',
    )
  })

  it('a contact slice without entryOpen falls through to the cover', () => {
    expect(alarmOpeningFrom({ contact: {}, cover: { state: 'closed' } })).toMatchObject({
      kind: 'reading',
      reading: 'secure',
      state: 'closed',
      cap: 'cover',
    })
  })

  it('an open contact beats a closed cover — the reed is the physical truth', () => {
    expect(
      alarmOpeningFrom({ contact: { entryOpen: true }, cover: { state: 'closed' } }),
    ).toMatchObject({
      kind: 'reading',
      reading: 'open',
      state: 'open',
      cap: 'contact',
    })
  })

  it('an unlocked lock beats a closed contact — secure-on-arm must see the controllable', () => {
    expect(
      alarmOpeningFrom({ contact: { entryOpen: false }, 'lock-control': { state: 'unlocked' } }),
    ).toMatchObject({
      kind: 'reading',
      reading: 'open',
      state: 'unlocked',
      cap: 'lock-control',
    })
  })
})

describe('readAlarmOpenings — the readDeviceOpenings dep contract', () => {
  it('a read that throws is ABSENT, with one debug line tagged by deviceId', async () => {
    const debug = vi.fn()
    const load = async (deviceId: number): Promise<Record<string, unknown>> => {
      if (deviceId === 3243) throw new Error('rpc timeout')
      if (deviceId === 102) return { camera: { streaming: true } }
      return { contact: { entryOpen: true } }
    }
    const out = await readAlarmOpenings([102, 3243, 4001], load, { debug })

    expect(out.has(3243)).toBe(false)
    expect(out.get(102)).toEqual({ kind: 'not-opening' })
    expect(out.get(4001)).toMatchObject({ kind: 'reading', reading: 'open', state: 'open' })
    expect(debug).toHaveBeenCalledTimes(1)
    expect(debug.mock.calls[0]?.[1]).toMatchObject({ tags: { deviceId: 3243 } })
  })
})

describe('readAlarmOpenings — concurrency', () => {
  it('reads concurrently, never more than 8 in flight, and keeps every id', async () => {
    let inFlight = 0
    let peak = 0
    const load = async (): Promise<Record<string, unknown>> => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise<void>((resolve) => setImmediate(resolve))
      inFlight -= 1
      return { contact: { entryOpen: false } }
    }
    const ids = Array.from({ length: 20 }, (_, i) => 1000 + i)
    const out = await readAlarmOpenings(ids, load, { debug: vi.fn() })
    expect(out.size).toBe(20)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(8)
  })
})

describe('classifyCoveredOpening — the one classifier (arm check and live view)', () => {
  it('absent is unknown/read-failed, an unknown word is unknown/unknown-word', () => {
    expect(classifyCoveredOpening(undefined)).toEqual({ kind: 'unknown', why: 'read-failed' })
    expect(classifyCoveredOpening({ kind: 'unknown', cap: 'cover', raw: 'ajar' })).toEqual({
      kind: 'unknown',
      why: 'unknown-word',
      cap: 'cover',
      raw: 'ajar',
    })
  })
  it('not-opening and secure are skipped; open carries its word', () => {
    expect(classifyCoveredOpening({ kind: 'not-opening' })).toEqual({ kind: 'skip' })
    expect(
      classifyCoveredOpening({
        kind: 'reading',
        reading: 'secure',
        state: 'closed',
        cap: 'contact',
      }),
    ).toEqual({ kind: 'skip' })
    expect(
      classifyCoveredOpening({
        kind: 'reading',
        reading: 'open',
        state: 'unlocked',
        cap: 'lock-control',
      }),
    ).toEqual({ kind: 'open', state: 'unlocked', controllable: true, cap: 'lock-control' })
  })
})

describe('alarmOpeningFromSensorEvent — the event row, read with the same table', () => {
  it('a contact row reads its entryOpen', () => {
    expect(alarmOpeningFromSensorEvent('contact', { entryOpen: false })).toMatchObject({
      kind: 'reading',
      reading: 'secure',
      state: 'closed',
      cap: 'contact',
    })
  })
  it('a cover row is secure only when closed', () => {
    expect(alarmOpeningFromSensorEvent('cover', { state: 'closed' })).toMatchObject({
      reading: 'secure',
    })
    expect(alarmOpeningFromSensorEvent('cover', { state: 'stopped' })).toMatchObject({
      reading: 'open',
    })
  })
  it('a lock row is secure only when locked', () => {
    expect(alarmOpeningFromSensorEvent('lock', { state: 'locked' })).toMatchObject({
      reading: 'secure',
    })
    expect(alarmOpeningFromSensorEvent('lock', { state: 'unlocked' })).toMatchObject({
      reading: 'open',
    })
  })
  it('an unknown word is unknown, and a non-opening kind is not an opening', () => {
    expect(alarmOpeningFromSensorEvent('cover', { state: 'ajar' }).kind).toBe('unknown')
    expect(alarmOpeningFromSensorEvent('lock', null).kind).toBe('unknown')
    expect(alarmOpeningFromSensorEvent('motion-sensor', { detected: true })).toEqual({
      kind: 'not-opening',
    })
  })
})

describe('rawForLog — what an unknown opening says in its log line', () => {
  it('a placeholder slice is spelled out, never "[object Object]"', () => {
    expect(rawForLog({ state: 'unlocked', lastChangedAt: 0 })).toBe(
      '{"state":"unlocked","lastChangedAt":0}',
    )
    expect(rawForLog('ajar')).toBe('ajar')
    expect(rawForLog(undefined)).toBe('undefined')
  })
})
