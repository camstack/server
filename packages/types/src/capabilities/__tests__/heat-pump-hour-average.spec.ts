import { describe, expect, it } from 'vitest'
import {
  heatPumpHourAverage,
  heatPumpHourAverageCop,
  heatPumpHourAverages,
  type HeatPumpCounterSample,
} from '../heat-pump-status.cap.js'

const H = 3_600_000
const at = (hours: number, value: number): HeatPumpCounterSample => ({ at: hours * H, value })

describe('heatPumpHourAverage', () => {
  it('turns the last counter step into the average power of that hour', () => {
    expect(heatPumpHourAverage([at(0, 100), at(1, 102.53)])).toBeCloseTo(2530, 6)
  })

  it('is unknown with a single sample, none, or a counter that never moved', () => {
    expect(heatPumpHourAverage([at(0, 100)])).toBeNull()
    expect(heatPumpHourAverage([])).toBeNull()
    expect(heatPumpHourAverage([at(0, 100), at(1, 100), at(2, 100)])).toBeNull()
  })

  it('counts each value from the first reading that carried it', () => {
    // 100 held from h0, 101 from h1 (repeated at h1.5), 103 from h2: the last step is h1 -> h2.
    const samples = [at(0, 100), at(1, 101), at(1.5, 101), at(2, 103)]
    expect(heatPumpHourAverage(samples)).toBeCloseTo(2000, 6)
  })

  it('ignores steps further apart than three hours and a counter that went backwards', () => {
    expect(heatPumpHourAverage([at(0, 100), at(3.5, 105)])).toBeNull()
    expect(heatPumpHourAverage([at(0, 100), at(1, 99)])).toBeNull()
  })

  it('does not depend on the order the samples arrive in', () => {
    expect(heatPumpHourAverage([at(1, 102.53), at(0, 100)])).toBeCloseTo(2530, 6)
  })
})

describe('heatPumpHourAverageCop', () => {
  it('divides the thermal energy of the electrical hour by that hour electrical energy', () => {
    const electrical = [at(0, 100), at(1, 102)]
    const thermal = [at(0, 500), at(0.5, 505), at(1, 509)]
    expect(heatPumpHourAverageCop(thermal, electrical)).toBeCloseTo(4.5, 6)
  })

  it('is unknown when the thermal counter does not cover the electrical hour', () => {
    expect(heatPumpHourAverageCop([at(2, 500)], [at(0, 100), at(1, 102)])).toBeNull()
    expect(heatPumpHourAverageCop([at(0, 500), at(1, 509)], [at(0, 100)])).toBeNull()
  })
})

describe('heatPumpHourAverages', () => {
  it('gives both powers and the COP of the same window', () => {
    expect(heatPumpHourAverages([at(0, 300), at(1, 310)], [at(0, 100), at(1, 102.5)])).toEqual({
      thermalW: 10_000,
      electricalW: 2500,
      cop: 4,
      fromAt: 0,
      toAt: H,
    })
  })

  it('is unknown without an electrical window, and keeps a thermal power it cannot cover unknown', () => {
    expect(heatPumpHourAverages([at(0, 300), at(1, 310)], [at(0, 100)])).toBeNull()
    expect(heatPumpHourAverages([], [at(0, 100), at(1, 102)])).toEqual({
      thermalW: null,
      electricalW: 2000,
      cop: null,
      fromAt: 0,
      toAt: H,
    })
  })
})
