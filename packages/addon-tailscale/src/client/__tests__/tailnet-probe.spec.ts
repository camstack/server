/**
 * The tailnet connection check: tri-state, the key never leaves it, and a CLI that does not
 * answer (unreachable, timed out) is `inconclusive` - never a verdict on the key.
 */
import { describe, expect, it } from 'vitest'
import { probeTailnet, scrubKey, type TailnetProbeCli, toTestResult } from '../tailnet-probe.js'

const KEY = 'tskey-auth-kAbCdE123456'
const healthy: TailnetProbeCli = {
  version: async () => '1.78.0',
  status: async () => ({ MagicDNSSuffix: 'example.ts.net' }),
}
const timedOut: TailnetProbeCli = {
  version: async () => {
    throw new Error(`Command failed: tailscale version --auth-key=${KEY} (timed out after 5000ms)`)
  },
  status: async () => ({}),
}

describe('tailnet probe', () => {
  it('a well-formed key with a reachable daemon is validated', async () => {
    const result = toTestResult(await probeTailnet(healthy, KEY), 12)
    expect(result).toMatchObject({ success: true, status: 'validated', detail: 'example.ts.net' })
  })

  it('an empty or malformed key is rejected, and the answer never carries the key', async () => {
    const empty = toTestResult(await probeTailnet(healthy, '  '), 1)
    expect(empty).toMatchObject({ success: false, status: 'rejected' })
    const wrong = toTestResult(await probeTailnet(healthy, 'not-a-key-SECRET'), 1)
    expect(wrong).toMatchObject({ success: false, status: 'rejected' })
    expect(JSON.stringify(wrong)).not.toContain('SECRET')
  })

  it('a daemon that times out is inconclusive, not a rejection, and the key is scrubbed from the error', async () => {
    const result = toTestResult(await probeTailnet(timedOut, KEY), 1)
    expect(result).toMatchObject({ success: false, status: 'inconclusive' })
    expect(JSON.stringify(result)).not.toContain(KEY)
    expect(result.error).toContain('[redacted]')
  })

  it('no key at all checks the daemon alone', async () => {
    expect(toTestResult(await probeTailnet(healthy, undefined), 1).status).toBe('validated')
    expect(scrubKey('plain', undefined)).toBe('plain')
  })
})
