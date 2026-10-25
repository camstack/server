import { describe, it, expect, vi } from 'vitest'
import type { IScopedLogger, DeviceProxy } from '@camstack/types'
import { AudioMetricsProvider } from '../audio-metrics-provider.js'

function makeLogger(): IScopedLogger {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
    withTags: () => log,
  } as unknown as IScopedLogger
  return log
}

/**
 * DeviceProxy stub. `setCapSlice` records `(deviceId, capName, slice)`
 * — same payload as the legacy `api.deviceState.setCapSlice.mutate`
 * call, so test assertions stay readable. Tests that don't care about
 * the mirror just ignore the recorded calls.
 */
function makeFetchDevice() {
  const setCapSlice = vi.fn(
    async (_args: { deviceId: number; capName: string; slice: Record<string, unknown> }) =>
      undefined,
  )
  const fetchDevice = async (deviceId: number): Promise<DeviceProxy> =>
    ({
      deviceState: {
        setCapSlice: (args: { capName: string; slice: Record<string, unknown> }) =>
          setCapSlice({ deviceId, ...args }),
      },
    }) as unknown as DeviceProxy
  return { fetchDevice, setCapSlice }
}

describe('AudioMetricsProvider', () => {
  it('returns null until first frame is recorded', async () => {
    const provider = new AudioMetricsProvider({
      logger: makeLogger(),
      fetchDevice: makeFetchDevice().fetchDevice,
    })
    expect(await provider.getCurrentSnapshot({ deviceId: 1 })).toBeNull()
  })

  it('records level + classification and mirrors via setCapSlice', async () => {
    const { fetchDevice, setCapSlice } = makeFetchDevice()
    const provider = new AudioMetricsProvider({ logger: makeLogger(), fetchDevice })
    await provider.recordAudioFrame({
      deviceId: 1,
      timestamp: 1_000,
      level: { rms: 0.1, dbfs: -20 },
      topClassification: { className: 'dog_bark', score: 0.85 },
    })
    const snap = await provider.getCurrentSnapshot({ deviceId: 1 })
    expect(snap).not.toBeNull()
    expect(snap!.level).toEqual({ rms: 0.1, dbfs: -20 })
    expect(snap!.current).toEqual({ className: 'dog_bark', score: 0.85, timestamp: 1_000 })
    expect(snap!.byClass).toHaveLength(1)
    expect(snap!.byClass[0]!.className).toBe('dog_bark')
    expect(setCapSlice).toHaveBeenCalledOnce()
    const call = setCapSlice.mock.calls[0]! as unknown as [{ capName: string }]
    expect(call[0].capName).toBe('audio-metrics')
  })

  it('aggregates per-class hits across multiple frames', async () => {
    const provider = new AudioMetricsProvider({
      logger: makeLogger(),
      fetchDevice: makeFetchDevice().fetchDevice,
    })
    for (let i = 0; i < 3; i++) {
      await provider.recordAudioFrame({
        deviceId: 1,
        timestamp: 1_000 + i * 100,
        level: { rms: 0.2, dbfs: -15 - i },
        topClassification: { className: 'speech', score: 0.7 + i * 0.05 },
      })
    }
    await provider.recordAudioFrame({
      deviceId: 1,
      timestamp: 1_400,
      level: { rms: 0.3, dbfs: -10 },
      topClassification: { className: 'dog_bark', score: 0.9 },
    })
    const snap = await provider.getCurrentSnapshot({ deviceId: 1 })
    expect(snap!.byClass.map((c) => c.className).toSorted()).toEqual(['dog_bark', 'speech'])
    const speech = snap!.byClass.find((c) => c.className === 'speech')!
    expect(speech.hits).toBe(3)
    expect(speech.peakScore).toBeCloseTo(0.8, 5)
    expect(snap!.peakDbfs).toBe(-10)
    // current is the most recent above-threshold hit
    expect(snap!.current?.className).toBe('dog_bark')
  })

  it('drops below-threshold classifications', async () => {
    const provider = new AudioMetricsProvider({
      logger: makeLogger(),
      fetchDevice: makeFetchDevice().fetchDevice,
      scoreThreshold: 0.5,
    })
    await provider.recordAudioFrame({
      deviceId: 1,
      timestamp: 1_000,
      level: { rms: 0.05, dbfs: -40 },
      topClassification: { className: 'maybe_voice', score: 0.3 }, // below threshold
    })
    const snap = await provider.getCurrentSnapshot({ deviceId: 1 })
    expect(snap!.current).toBeNull()
    expect(snap!.byClass).toHaveLength(0)
    // Level is still recorded — silence vs no-classification are different.
    expect(snap!.level.dbfs).toBe(-40)
  })

  it('expires entries older than the rolling window', async () => {
    const provider = new AudioMetricsProvider({
      logger: makeLogger(),
      fetchDevice: makeFetchDevice().fetchDevice,
      windowSec: 5,
    })
    // Old hit (well outside the 5s window)
    await provider.recordAudioFrame({
      deviceId: 1,
      timestamp: 0,
      level: { rms: 0.1, dbfs: -30 },
      topClassification: { className: 'old_class', score: 0.9 },
    })
    // Recent hit — pushes the cutoff past `0`
    await provider.recordAudioFrame({
      deviceId: 1,
      timestamp: 10_000,
      level: { rms: 0.1, dbfs: -20 },
      topClassification: { className: 'fresh_class', score: 0.9 },
    })
    const snap = await provider.getCurrentSnapshot({ deviceId: 1 })
    expect(snap!.byClass.map((c) => c.className)).toEqual(['fresh_class'])
  })

  it('forgetDevice drops the snapshot', async () => {
    const provider = new AudioMetricsProvider({
      logger: makeLogger(),
      fetchDevice: makeFetchDevice().fetchDevice,
    })
    await provider.recordAudioFrame({
      deviceId: 7,
      timestamp: 1_000,
      level: { rms: 0.1, dbfs: -20 },
    })
    expect(await provider.getCurrentSnapshot({ deviceId: 7 })).not.toBeNull()
    provider.forgetDevice(7)
    expect(await provider.getCurrentSnapshot({ deviceId: 7 })).toBeNull()
  })
})
