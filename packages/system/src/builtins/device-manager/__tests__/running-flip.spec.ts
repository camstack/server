import { describe, expect, it } from 'vitest'
import { RunningFlipDetector } from '../running-flip.js'

describe('RunningFlipDetector', () => {
  it('seeded true followed by true emits nothing', () => {
    const det = new RunningFlipDetector()
    det.seed(1, true)
    expect(det.note(1, { running: true, since: 100, phase: null })).toBeNull()
  })

  it('true after false emits started', () => {
    const det = new RunningFlipDetector()
    det.seed(1, false)
    const ev = det.note(1, { running: true, since: 200, phase: 'Run' })
    expect(ev).toEqual({ kind: 'started', deviceId: 1, since: 200, phase: 'Run' })
  })

  it('false after true emits finished', () => {
    const det = new RunningFlipDetector()
    det.seed(1, true)
    const ev = det.note(1, { running: false, since: 300, phase: 'Finished' })
    expect(ev).toEqual({ kind: 'finished', deviceId: 1, since: 300, phase: 'Finished' })
  })

  it('null is not an edge', () => {
    const det = new RunningFlipDetector()
    det.seed(1, true)
    expect(det.note(1, { running: null, since: null, phase: null })).toBeNull()
    det.seed(2, null)
    expect(det.note(2, { running: false, since: 1, phase: null })).toBeNull()
  })

  it('unseeded false emits nothing', () => {
    const det = new RunningFlipDetector()
    expect(det.note(3, { running: false, since: null, phase: null })).toBeNull()
  })
})
