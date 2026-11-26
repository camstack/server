/**
 * The mirror tells the scheduler whether a reported slice is a cold seed (a
 * construction placeholder, stamp 0) or a reading (D1099).
 */
import { describe, expect, it } from 'vitest'
import { harness } from './mirror-harness.js'

describe('DeviceStateMirror report tap', () => {
  function taps() {
    const h = harness()
    const seen: Array<{ capName: string; cold: boolean }> = []
    h.mirror.setReportTap((_deviceId, capName, cold) => void seen.push({ capName, cold }))
    return { h, seen }
  }

  it('a slice stamped 0 is reported cold', () => {
    const { h, seen } = taps()
    h.mirror.applySingleCapUpdate(7, 'lock-control', { state: 'unlocked', lastChangedAt: 0 })
    expect(seen).toEqual([{ capName: 'lock-control', cold: true }])
  })

  it('a slice with a real stamp is reported as a reading', () => {
    const { h, seen } = taps()
    h.mirror.applySingleCapUpdate(7, 'lock-control', { state: 'locked', lastChangedAt: 1_700 })
    expect(seen).toEqual([{ capName: 'lock-control', cold: false }])
  })

  it('a slice with no stamp is a reading', () => {
    const { h, seen } = taps()
    h.mirror.applySingleCapUpdate(7, 'zones', { zones: [] })
    expect(seen).toEqual([{ capName: 'zones', cold: false }])
  })
})
