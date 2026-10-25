import type { AddonApi, AddonContext, IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildEndpointsForExposedDevice, type DeviceBuildContext } from '../handlers/discovery.js'

interface HarnessOpts {
  readonly capNames: readonly string[]
  readonly type?: string
  readonly panelStatus?: unknown
  readonly failPanelStatus?: boolean
}

function harness(opts: HarnessOpts) {
  const logs: Array<{ level: string; message: string; tags: Record<string, unknown> }> = []
  const record =
    (level: string) =>
    (message: string, extra?: { tags?: Record<string, unknown> }): void => {
      logs.push({ level, message, tags: extra?.tags ?? {} })
    }
  // Documented test-stub boundary: discovery reads four methods of an API
  // surface far too large to build by hand.
  const logger = {
    info: record('info'),
    warn: record('warn'),
    debug: record('debug'),
    error: record('error'),
    withTags: () => logger,
  } as unknown as IScopedLogger
  let childrenCalls = 0
  const api = {
    deviceManager: {
      getDevice: {
        query: async () => ({
          id: 102,
          stableId: 'panel-102',
          name: 'Casa',
          features: [],
          type: opts.type ?? 'alarm-panel',
        }),
      },
      getBindings: {
        query: async () => ({ entries: opts.capNames.map((capName) => ({ capName })) }),
      },
      getChildren: {
        query: async () => {
          childrenCalls += 1
          return []
        },
      },
    },
    alarmPanel: {
      getStatus: {
        query: async () => {
          if (opts.failPanelStatus === true) throw new Error('provider not available')
          return (
            opts.panelStatus ?? {
              state: 'disarmed',
              availableModes: ['home', 'away'],
              requiresCode: false,
              lastChangedAt: 1,
            }
          )
        },
      },
    },
  } as unknown as AddonApi
  const deps: DeviceBuildContext = {
    ctx: { api } as unknown as AddonContext,
    logger,
  }
  return { deps, logs, childrenCalls: () => childrenCalls }
}

describe('discovery — an alarm panel is its own endpoint', () => {
  it('publishes ONE SecurityPanelController endpoint, not a camera', async () => {
    const h = harness({ capNames: ['alarm-panel'] })
    const endpoints = await buildEndpointsForExposedDevice(102, h.deps)
    expect(endpoints).toHaveLength(1)
    expect(endpoints[0]?.endpointId).toBe('102__alarm')
    expect(endpoints[0]?.capabilities.map((c) => c.interface)).toEqual([
      'Alexa',
      'Alexa.SecurityPanelController',
    ])
    // A panel has no stream and no children; discovery must not pay for the
    // walk, and must not publish a CAMERA endpoint that nothing can answer.
    expect(h.childrenCalls()).toBe(0)
  })

  it('carries only the arm states the panel accepts', async () => {
    const h = harness({ capNames: ['alarm-panel'] })
    const endpoints = await buildEndpointsForExposedDevice(102, h.deps)
    const panel = endpoints[0]?.capabilities.find(
      (c) => c.interface === 'Alexa.SecurityPanelController',
    )
    expect(panel?.configuration?.supportedArmStates).toEqual([
      { value: 'ARMED_STAY' },
      { value: 'ARMED_AWAY' },
      { value: 'DISARMED' },
    ])
  })

  it('declares every arm state, and SAYS SO, when the panel could not be read', async () => {
    // Unknown is not "accepts nothing". Publishing a panel that can only be
    // disarmed, on a status read that simply failed, takes the controls off a
    // working alarm.
    const h = harness({ capNames: ['alarm-panel'], failPanelStatus: true })
    const endpoints = await buildEndpointsForExposedDevice(102, h.deps)
    const panel = endpoints[0]?.capabilities.find(
      (c) => c.interface === 'Alexa.SecurityPanelController',
    )
    expect(panel?.configuration?.supportedArmStates).toHaveLength(4)
    const warn = h.logs.find((l) => l.level === 'warn')
    expect(warn?.tags.deviceId).toBe(102)
  })

  it('branches on the BOUND CAP, not the device type', async () => {
    const h = harness({ capNames: ['alarm-panel'], type: 'generic' })
    const endpoints = await buildEndpointsForExposedDevice(102, h.deps)
    expect(endpoints[0]?.endpointId).toBe('102__alarm')
  })

  it('leaves a camera alone', async () => {
    const h = harness({ capNames: ['motion'], type: 'camera' })
    const endpoints = await buildEndpointsForExposedDevice(102, h.deps)
    expect(endpoints[0]?.endpointId).toBe('102')
    expect(endpoints[0]?.displayCategories).toEqual(['CAMERA'])
  })
})
