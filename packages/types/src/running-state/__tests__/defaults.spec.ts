import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device/device-type.js'
import { runningPowerDefaultsFor } from '../defaults.js'
import { proposeRunningThreshold } from '../propose-threshold.js'
import { tooShort } from './__fixtures__/power-series.js'

describe('runningPowerDefaultsFor', () => {
  it('a media player draws power at once: 10 s start, 10 s stop, one sample', () => {
    expect(runningPowerDefaultsFor(DeviceType.MediaPlayer)).toEqual({
      startDwellMs: 10_000,
      stopDwellMs: 10_000,
      minSamples: 1,
    })
  })

  it('every other type, and an unknown one, keeps the global values', () => {
    const global = {
      startDwellMs: 30_000,
      stopDwellMs: 180_000,
      minSamples: 2,
    }
    expect(runningPowerDefaultsFor(DeviceType.Washer)).toEqual(global)
    expect(runningPowerDefaultsFor(undefined)).toEqual(global)
  })

  it('the proposal fallback for a media player carries its defaults', () => {
    const answer = proposeRunningThreshold({
      ...tooShort(),
      deviceType: DeviceType.MediaPlayer,
    })
    if (answer.state !== 'insufficient') throw new Error('expected insufficient')
    expect(answer.fallback).toMatchObject({
      startDwellMs: 10_000,
      stopDwellMs: 10_000,
      minSamples: 1,
    })
  })
})
