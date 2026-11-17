/**
 * The live probe logs in ONCE: a connection test sends a refused password a single time, so a
 * test never counts three failed logins toward the device's lockout (nodelink-js 0.12.5 option).
 */
import { describe, expect, it, vi } from 'vitest'

const loginCalls: unknown[][] = []

vi.mock('@apocaliss92/nodelink-js', () => ({
  ReolinkBaichuanApi: class {
    login(...args: unknown[]): Promise<void> {
      loginCalls.push(args)
      return Promise.resolve()
    }
    close(): Promise<void> {
      return Promise.resolve()
    }
  },
}))

describe('liveReolinkHubProbe', () => {
  it('asks the library for exactly one login attempt', async () => {
    const { liveReolinkHubProbe } = await import('../reolink-connection-test.js')
    const probe = liveReolinkHubProbe({
      host: '192.0.2.10',
      port: 9000,
      username: 'admin',
      password: 'x',
      transport: 'tcp',
    })
    await probe.login()
    expect(loginCalls).toEqual([[undefined, { maxAttempts: 1 }]])
  })
})
