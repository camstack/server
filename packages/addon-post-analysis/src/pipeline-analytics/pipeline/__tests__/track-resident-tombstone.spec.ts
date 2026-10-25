import { describe, expect, it } from 'vitest'
import { type LateAbsorbedWork, TrackResidentState } from '../track-resident-state.js'

function observe(residents: TrackResidentState, deviceId: number, id: string): boolean {
  return residents.observeBestFrame(deviceId, id, 0.9, 1_000, true, 0.5, 1, 0.5, 0.5, false, 0.1)
}

describe('a closed id is never re-created by late per-frame work', () => {
  it('observeBestFrame / markConfirmed after close refuse and leave no resident', () => {
    const refusals: LateAbsorbedWork[] = []
    const residents = new TrackResidentState({ onLateAbsorbedWork: (w) => refusals.push(w) })

    residents.open(7, 'a')
    residents.close('a', 'prune')
    expect(residents.size()).toBe(0)

    expect(observe(residents, 7, 'a')).toBe(false)
    expect(residents.size()).toBe(0)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.reason).toBe('track-closed')
    expect(refusals[0]?.write).toBe('observeBestFrame')

    residents.markConfirmed(7, 'a')
    residents.setLastFrameAt(7, 'a', 2_000)
    expect(residents.size()).toBe(0)
  })

  it('a real birth (open) is the only thing that lifts the tombstone', () => {
    const residents = new TrackResidentState()
    residents.open(7, 'a')
    residents.close('a', 'prune')
    residents.open(7, 'a')
    expect(residents.size()).toBe(1)
    expect(observe(residents, 7, 'a')).toBe(true)
  })

  it('idleResidents lists only residents with an old frame stamp', () => {
    const residents = new TrackResidentState()
    residents.open(1, 'old')
    residents.setLastFrameAt(1, 'old', 1_000)
    residents.open(1, 'fresh')
    residents.setLastFrameAt(1, 'fresh', 9_000)
    residents.open(1, 'unstamped')
    expect(residents.idleResidents(5_000)).toEqual([
      { trackId: 'old', deviceId: 1, lastFrameAt: 1_000 },
    ])
  })
})
