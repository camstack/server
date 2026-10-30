import { describe, expect, it } from 'vitest'
import { calibrateApply, calibrateCamera } from '../mcp/configure-calibrate.js'
import { withWrites } from './configure-gate-ctx.js'
import { fakeHub } from './ops-fake-hub.js'

const track = (className: string, score: number, moved = true): object => ({
  trackId: Math.random().toString(36),
  className,
  moved,
  positions: [{ score: score - 0.1 }, { score }],
})

const motionContribution = {
  sections: [
    {
      id: 'motion',
      fields: [
        {
          key: 'minArea',
          type: 'number',
          label: 'Min area',
          value: 1500,
          min: 0,
          max: 50000,
        },
        {
          key: 'blurRadius',
          type: 'number',
          label: 'Blur',
          value: 2,
          min: 0,
          max: 8,
        },
        {
          key: 'mode',
          type: 'select',
          label: 'Mode',
          value: 'a',
          options: [{ value: 'a' }, { value: 'b' }],
        },
      ],
    },
  ],
}

function reads(tracks: readonly object[]): Record<string, unknown> {
  return {
    'pipelineAnalytics.listRecentTracks': { tracks },
    'pipelineOrchestrator.getCameraMetrics': {
      configuredFps: 10,
      actualFps: 4,
      droppedFrames: 30,
      detectionMode: 'always',
    },
    'motionDetection.getDeviceSettingsContribution': motionContribution,
    'pipelineOrchestrator.getDeviceSettingsContribution': { sections: [] },
    'zones.listZones': [{ id: 'z1', name: 'Lawn', kind: 'polygon' }],
    'motionZones.getStatus': {
      grid: [
        [1, 0],
        [0, 1],
      ],
    },
    'motionDetection.applyDeviceSettingsPatch': { success: true },
  }
}

describe('configure_calibrate_camera', () => {
  it('reports the score distribution, finds weak person tracks and proposes a larger minArea', async () => {
    const tracks = [
      ...Array.from({ length: 6 }, () => track('person', 0.55)),
      ...Array.from({ length: 4 }, () => track('person', 0.9)),
    ]
    const { ctx } = fakeHub(reads(tracks))
    const out = await calibrateCamera(ctx, { deviceId: 7 })
    if (out.status !== 'ok') throw new Error(JSON.stringify(out))
    expect(out.scoreDistributionPerClass).toMatchObject([
      {
        className: 'person',
        tracks: 10,
        weak: 6,
        buckets: { from50to65: 6, from80: 4 },
      },
    ])
    expect(JSON.stringify(out.findings)).toMatch(/false positives on .{1,3}person/)
    expect(out.proposals).toEqual([
      expect.objectContaining({
        cap: 'motionDetection',
        key: 'minArea',
        from: 1500,
        to: 2250,
      }),
    ])
    expect(JSON.stringify(out.findings)).toMatch(/not keeping up/)
    expect(String(out.metrics)).toMatch(/Benchmark and Model Studio/)
    expect(JSON.stringify(out.advice)).toMatch(/per accelerator and node/)
  })

  it('proposes nothing from a handful of tracks', async () => {
    const { ctx } = fakeHub(reads([track('person', 0.5), track('person', 0.5)]))
    const out = await calibrateCamera(ctx, { deviceId: 7 })
    expect(out).toMatchObject({ proposals: [] })
  })

  it('names what it could not read instead of reporting an empty camera', async () => {
    const { ctx } = fakeHub({
      ...reads([]),
      'pipelineAnalytics.listRecentTracks': new Error('boom'),
    })
    const out = await calibrateCamera(ctx, { deviceId: 7 })
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.unavailable).toMatchObject({
      tracks: expect.stringContaining('boom'),
    })
  })
})

describe('configure_calibrate_apply', () => {
  it('previews before/after per key and applies through applyDeviceSettingsPatch', async () => {
    const { ctx, calls } = fakeHub(reads([]))
    const writable = withWrites(ctx)
    const args = {
      deviceId: 7,
      cap: 'motionDetection' as const,
      patch: { minArea: 2250 },
    }
    const preview = await calibrateApply(writable, args, undefined)
    if (preview.status !== 'dry-run') throw new Error(JSON.stringify(preview))
    expect(JSON.stringify(preview)).toContain('"before":1500')
    expect(calls.some((c) => c.path.endsWith('applyDeviceSettingsPatch'))).toBe(false)
    await calibrateApply(writable, args, preview.confirm_token)
    expect(calls.find((c) => c.path === 'motionDetection.applyDeviceSettingsPatch')?.input).toEqual(
      {
        deviceId: 7,
        patch: { minArea: 2250 },
      },
    )
  })

  it('refuses an unknown key, an out-of-range number and a confidence floor', async () => {
    const { ctx } = fakeHub(reads([]))
    const writable = withWrites(ctx)
    const text = async (patch: Record<string, number>): Promise<string> =>
      JSON.stringify(
        await calibrateApply(writable, { deviceId: 7, cap: 'motionDetection', patch }, undefined),
      )
    expect(await text({ nope: 1 })).toMatch(/no such setting/)
    expect(await text({ minArea: 999_999 })).toMatch(/above the maximum 50000/)
    expect(await text({ minConfidencePerson: 0.8 })).toMatch(/per accelerator and node/)
  })
})
