import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@dominevo/types'
import { buildMatterBrokerProvider } from '../matter-broker-provider.js'

interface Line {
  readonly message: string
  readonly brokerId: unknown
  readonly reason: unknown
}

function setup(known: readonly string[]) {
  const lines: Line[] = []
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, ctx) => {
      lines.push({
        message,
        brokerId: ctx?.tags?.['brokerId'],
        reason: ctx?.meta?.['reason'],
      })
    },
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  const provider = buildMatterBrokerProvider({
    registry: {
      size: () => 0,
      connectedCount: () => 0,
      commissionNode: async () => ({ nodeId: '1' }),
      getCommissionProgress: () => null,
    },
    getBrokers: () =>
      known.map((id) => ({
        id,
        name: id,
        connection: {
          threadDataset: '',
          wifiSsid: '',
          wifiPassword: '',
          reconcileIntervalMs: 300_000,
        },
      })),
    logger,
  })
  return { provider, lines }
}

describe('matter broker provider publish refusals', () => {
  it('names an unknown broker', async () => {
    const { provider, lines } = setup(['matter_001'])
    await expect(
      provider.publish({
        brokerId: 'mqtt_9',
        target: { action: 'commissionNode' },
        payload: { pairingCode: '34970112332' },
      }),
    ).rejects.toThrow('unknown broker')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      brokerId: 'mqtt_9',
      reason: 'unknown-broker',
    })
  })

  it('names a pairing code that does not parse', async () => {
    const { provider, lines } = setup(['matter_001'])
    await expect(
      provider.publish({
        brokerId: 'matter_001',
        target: { action: 'commissionNode' },
        payload: { pairingCode: 'nope' },
      }),
    ).rejects.toThrow()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      brokerId: 'matter_001',
      reason: 'invalid-pairing-code',
    })
  })

  it('names an unsupported action', async () => {
    const { provider, lines } = setup(['matter_001'])
    await expect(
      provider.publish({
        brokerId: 'matter_001',
        target: { action: 'x' },
        payload: {},
      }),
    ).rejects.toThrow('unsupported')
    expect(lines[0]).toMatchObject({
      brokerId: 'matter_001',
      reason: 'unsupported-action',
    })
  })
})
