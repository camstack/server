import { describe, it, expect, beforeEach, vi } from 'vitest'
import { __resetCapUsageRegistryForTests, getCapUsageRegistry } from '@camstack/system'
import { buildNodesProvider } from '../../api/core/cap-providers'

describe('nodes.getCapUsageGraph provider', () => {
  beforeEach(() => {
    __resetCapUsageRegistryForTests()
  })

  it('returns recorded edges projected through the cap-usage registry', async () => {
    const reg = getCapUsageRegistry()
    const t0 = Date.now() - 5_000
    reg.recordCall({
      callerAddonId: 'A',
      providerAddonId: 'B',
      capName: 'foo',
      methodName: 'm',
      atMs: t0,
    })
    reg.recordCall({
      callerAddonId: 'A',
      providerAddonId: 'B',
      capName: 'foo',
      methodName: 'm',
      atMs: t0 + 1000,
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const provider = buildNodesProvider({} as any, { broker: { call: vi.fn() } } as any)
    const out = await provider.getCapUsageGraph({ windowSeconds: 60 })
    expect(out).toHaveLength(1)
    expect(out[0]!.callerAddonId).toBe('A')
    expect(out[0]!.providerAddonId).toBe('B')
    expect(out[0]!.capName).toBe('foo')
    expect(out[0]!.callsPerMin).toBeGreaterThan(0)
  })
})
