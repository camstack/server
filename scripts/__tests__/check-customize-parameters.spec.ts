/**
 * D944 — every declared behaviour parameter is on the catalog the editor reads.
 */
import { describe, expect, it } from 'vitest'
import { loadCustomizeCaps } from '../lib/customize-declaration.ts'
import { projectCustomize } from '../lib/customize-project.ts'

describe('customize parameter projection', () => {
  it('projects clamp, threshold defaults, comparison options, edges and debounce', async () => {
    const caps = await loadCustomizeCaps()
    const battery = caps.find((cap) => cap.capName === 'battery')
    const running = caps.find((cap) => cap.capName === 'running-state')
    const doorbell = caps.find((cap) => cap.capName === 'doorbell')
    const motion = caps.find((cap) => cap.capName === 'motion')
    const consumables = caps.find((cap) => cap.capName === 'consumables')
    if (
      battery === undefined ||
      running === undefined ||
      doorbell === undefined ||
      motion === undefined ||
      consumables === undefined
    ) {
      throw new Error('missing customize cap')
    }
    const batteryJson = JSON.stringify(projectCustomize(battery))
    expect(batteryJson).toContain('"clampMin":0')
    expect(batteryJson).toContain('"clampMax":100')
    expect(batteryJson).toContain('"defaultScale":1')
    expect(batteryJson).toContain('"defaultOffset":0')

    const runningJson = JSON.stringify(projectCustomize(running))
    expect(runningJson).toContain('"defaultThreshold":5')
    expect(runningJson).toContain('"comparison":"gte"')
    expect(runningJson).toContain('"gte"')
    expect(runningJson).toContain('"lte"')
    expect(runningJson).toContain('"defaultStartDwellMs":30000')
    expect(runningJson).toContain('"defaultStopDwellMs":180000')

    const doorbellJson = JSON.stringify(projectCustomize(doorbell))
    expect(doorbellJson).toContain('"defaultEdge":"rising"')
    expect(doorbellJson).toContain('"debounceMs":2000')

    const motionJson = JSON.stringify(projectCustomize(motion))
    expect(motionJson).toContain('"timeoutMs":30000')
    expect(motionJson).toContain('"in-addition"')
    expect(motionJson).toContain('"confirm"')
    expect(motionJson).toContain('"replace"')

    const consumablesJson = JSON.stringify(projectCustomize(consumables))
    expect(consumablesJson).toContain('"clampMin":0')
    expect(consumablesJson).toContain('"clampMax":100')
  })
})
