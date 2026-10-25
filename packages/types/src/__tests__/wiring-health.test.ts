import { describe, it, expect } from 'vitest'
import { wiringHealthSnapshotSchema, type WiringHealthSnapshot } from '../health/wiring-health.js'

describe('wiringHealthSnapshotSchema', () => {
  const valid: WiringHealthSnapshot = {
    ok: false,
    degraded: true,
    checkedAt: new Date().toISOString(),
    nodes: [
      {
        nodeId: 'hub',
        addons: [
          {
            addonId: 'provider-reolink',
            caps: [
              {
                capName: 'ptz',
                kind: 'device',
                deviceId: 7,
                reachable: false,
                latencyMs: 3000,
                error: 'not available on node',
              },
              {
                capName: 'stream-params',
                kind: 'device',
                deviceId: 7,
                reachable: true,
                latencyMs: 4,
              },
            ],
            widgets: [],
          },
        ],
      },
    ],
    summary: { total: 2, reachable: 1, unreachable: 1 },
  }

  it('parses a valid snapshot', () => {
    const parsed = wiringHealthSnapshotSchema.parse(valid)
    expect(parsed.ok).toBe(false)
    expect(parsed.summary.unreachable).toBe(1)
    expect(parsed.nodes[0]!.addons[0]!.caps[0]!.kind).toBe('device')
  })

  it('rejects an invalid kind', () => {
    const bad = {
      ...valid,
      nodes: [
        {
          nodeId: 'hub',
          addons: [
            {
              addonId: 'x',
              caps: [{ capName: 'c', kind: 'bogus', reachable: true, latencyMs: 1 }],
              widgets: [],
            },
          ],
        },
      ],
    }
    expect(() => wiringHealthSnapshotSchema.parse(bad)).toThrow()
  })

  it('rejects a missing summary', () => {
    const { summary: _omit, ...bad } = valid
    expect(() => wiringHealthSnapshotSchema.parse(bad)).toThrow()
  })
})
