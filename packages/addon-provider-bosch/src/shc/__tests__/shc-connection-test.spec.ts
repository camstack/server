import { describe, expect, it, vi } from 'vitest'
import { buildShcConnectionTestProvider, SHC_REACHABILITY_PORT } from '../shc-connection-test.js'

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

describe('SHC connection test', () => {
  it('validates when the controller address accepts a connection', async () => {
    const probe = vi.fn(async () => true)
    const provider = buildShcConnectionTestProvider({ logger: logger() as never, probe })
    const outcome = await provider.testSettings({
      settings: { host: ' 192.168.1.59 ', sslCertificate: 'cert', sslKey: 'key' },
    })
    expect(outcome.outcome).toBe('validated')
    expect(probe).toHaveBeenCalledWith('192.168.1.59', SHC_REACHABILITY_PORT)
  })

  it('rejects an unreachable address', async () => {
    const provider = buildShcConnectionTestProvider({
      logger: logger() as never,
      probe: async () => false,
    })
    const outcome = await provider.testSettings({ settings: { host: '192.168.1.59' } })
    expect(outcome.outcome).toBe('rejected')
    if (outcome.outcome === 'rejected') {
      expect(outcome.error).toContain('192.168.1.59')
      expect(outcome.error).toContain(String(SHC_REACHABILITY_PORT))
    }
  })

  it('rejects a missing host', async () => {
    const probe = vi.fn(async () => true)
    const provider = buildShcConnectionTestProvider({ logger: logger() as never, probe })
    const outcome = await provider.testSettings({ settings: {} })
    expect(outcome.outcome).toBe('rejected')
    expect(probe).not.toHaveBeenCalled()
  })
})
