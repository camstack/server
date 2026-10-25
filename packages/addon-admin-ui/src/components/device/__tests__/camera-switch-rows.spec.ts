import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  iconKeyForLabel,
  parseCameraSwitchRows,
  summariseCameraSwitches,
} from '../camera-switch-rows'

/**
 * The admin UI renders the hub's switch group, and keeps no catalog of its own
 * (D544).
 *
 * It used to re-derive four of the nine rows locally, so `privacy-mask`,
 * `device-audio`, `broker-audio`, `stream-broker` and `notifications` had no
 * representation in device details at all — while the viewer showed all nine
 * from the wire. Two derivations of one catalog do not stay in step.
 */

const ROW = {
  id: 'privacy-mask',
  label: 'Privacy mask',
  costWhenOff: 'On: the zones you drew are blacked out by the camera itself.',
  available: true,
  enabled: false,
  authority: { kind: 'camera-mask', capName: 'privacy-mask' },
}

describe('parseCameraSwitchRows', () => {
  it('renders a switch id it has never heard of, from the label the hub sent', () => {
    const rows = parseCameraSwitchRows({
      switches: [{ ...ROW, id: 'something-new', label: 'Something new' }],
    })
    expect(rows?.[0]?.id).toBe('something-new')
    expect(rows?.[0]?.label).toBe('Something new')
  })

  it('keeps the order the hub sent rather than imposing one', () => {
    const rows = parseCameraSwitchRows({
      switches: [
        { ...ROW, id: 'b', label: 'B' },
        { ...ROW, id: 'a', label: 'A' },
      ],
    })
    expect(rows?.map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('an unreadable payload is null — never an empty list', () => {
    // Empty would render "this camera has no functions", which is a claim a
    // query that has not answered may not make (D315).
    expect(parseCameraSwitchRows(undefined)).toBeNull()
    expect(parseCameraSwitchRows({})).toBeNull()
    expect(parseCameraSwitchRows({ switches: 'no' })).toBeNull()
  })

  it('drops a malformed row without taking the list with it', () => {
    expect(parseCameraSwitchRows({ switches: [ROW, { id: 7 }] })).toHaveLength(1)
  })

  it('an unavailable switch is never reported as ON or OFF', () => {
    const rows = parseCameraSwitchRows({
      switches: [{ ...ROW, available: false, enabled: false }],
    })
    expect(rows?.[0]?.on).toBeNull()
    expect(rows?.[0]?.available).toBe(false)
  })
})

describe('iconKeyForLabel — decoration, matched on the label', () => {
  it('recognises the labels this hub sends today', () => {
    expect(iconKeyForLabel('Privacy mask')).toBe('privacy')
    expect(iconKeyForLabel('Camera microphone')).toBe('microphone')
    expect(iconKeyForLabel('Audio analysis')).toBe('listening')
    expect(iconKeyForLabel('Recording')).toBe('recording')
  })

  it('gives an unrecognised label a complete, generic control', () => {
    expect(iconKeyForLabel('Something the hub invented')).toBe('generic')
    expect(iconKeyForLabel('')).toBe('generic')
  })
})

describe('summariseCameraSwitches — an off function is REPORTED off', () => {
  const rows = [
    { id: 'a', label: 'A', costWhenOff: '', on: false, available: true, unavailableReason: null },
    { id: 'b', label: 'B', costWhenOff: '', on: null, available: false, unavailableReason: null },
    { id: 'c', label: 'C', costWhenOff: '', on: true, available: true, unavailableReason: null },
  ]

  it('keeps the OFF report on the collapsed trigger', () => {
    const fold = summariseCameraSwitches(rows)
    expect(fold.offIds).toEqual(['a'])
    expect(fold.summary).toContain('A')
  })

  it('never counts an unknown as off', () => {
    const fold = summariseCameraSwitches(rows)
    expect(fold.offIds).not.toContain('b')
    expect(fold.unknownIds).toEqual(['b'])
  })

  it('says so when everything is on', () => {
    expect(summariseCameraSwitches([rows[2]!]).summary).toBe('All camera functions on')
  })
})

/**
 * The same guard the viewer carries, on this side of the wire.
 *
 * D544 puts `label`, `costWhenOff` and `available` on the wire precisely so
 * neither client needs a catalog. The moment a file branches on an id, the
 * next switch the hub adds renders wrong — or not at all — and nobody finds
 * out until an operator reports a function they cannot turn off. That is
 * exactly how the five missing rows went unnoticed here.
 */
describe('guard: the admin UI never enumerates the switches', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const DEVICE_ROOT = resolve(here, '..')

  /**
   * Scoped to the switch surface itself, not to all of `device/`.
   *
   * `detection-settings-groups.ts` has an `object-detection` of its own — a
   * settings-GROUP id in the detection tab, a different namespace that shares
   * a word. Failing on it would teach the next person to rename an unrelated
   * concept to satisfy a guard, which is how guards get disabled.
   */
  const SWITCH_SURFACE = ['camera-switch-rows.ts', 'CameraFunctionSwitches.tsx']

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === '__tests__') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) continue
      if (SWITCH_SURFACE.includes(entry)) out.push(full)
    }
    return out
  }

  it('the switch surface never mentions a switch id', () => {
    // The distinctive ones only: `recording` and `notifications` are ordinary
    // words this app uses everywhere.
    const ids = ['stream-broker', 'object-detection', 'audio-analysis', 'device-audio']
    const offenders: string[] = []
    for (const file of sourceFiles(DEVICE_ROOT)) {
      const text = readFileSync(file, 'utf8')
      for (const id of ids) {
        if (text.includes(`'${id}'`) || text.includes(`"${id}"`)) {
          offenders.push(`${file.slice(DEVICE_ROOT.length + 1)} → ${id}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
