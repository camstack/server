import { describe, expect, it } from 'vitest'
import {
  buildAgentDashboardBaseUrl,
  buildAgentDashboardTicketUrl,
  isAgentDashboardHost,
  parseMintUnlockResult,
  pickAgentDashboardHost,
} from '../agent-dashboard-unlock'

describe('parseMintUnlockResult', () => {
  it('reads ticket and dashboardUrl', () => {
    expect(
      parseMintUnlockResult({
        ticket: 'abc.def',
        dashboardUrl: 'http://192.168.1.10:4444/?ticket=abc.def',
        exp: 1,
        nodeId: 'n1',
      }),
    ).toEqual({
      ticket: 'abc.def',
      dashboardUrl: 'http://192.168.1.10:4444/?ticket=abc.def',
    })
  })

  it('accepts ticket alone', () => {
    expect(parseMintUnlockResult({ ticket: 't' })).toEqual({ ticket: 't' })
  })

  it('rejects malformed', () => {
    expect(parseMintUnlockResult(null)).toBeNull()
    expect(parseMintUnlockResult({ dashboardUrl: 'http://x:4444/' })).toBeNull()
    expect(parseMintUnlockResult({ ticket: '' })).toBeNull()
  })
})

describe('pickAgentDashboardHost', () => {
  it('prefers reachableHost', () => {
    expect(pickAgentDashboardHost(['10.0.0.2', '192.168.1.5'], '192.0.2.10')).toBe('192.0.2.10')
  })

  it('skips loopback and link-local', () => {
    expect(pickAgentDashboardHost(['127.0.0.1', '169.254.1.1', '192.168.1.5'], null)).toBe(
      '192.168.1.5',
    )
  })

  it('prefers LAN over Tailscale CGNAT and docker bridge', () => {
    expect(pickAgentDashboardHost(['100.108.60.124', '172.17.0.1', '192.168.1.20'], null)).toBe(
      '192.168.1.20',
    )
  })

  it('rejects path-like reachableHost', () => {
    expect(isAgentDashboardHost('http://x')).toBe(false)
    expect(pickAgentDashboardHost(['192.168.1.5'], 'http://evil')).toBe('192.168.1.5')
  })
})

describe('buildAgentDashboard URLs', () => {
  it('builds base and ticket URLs', () => {
    expect(buildAgentDashboardBaseUrl('192.168.1.5')).toBe('http://192.168.1.5:4444/')
    expect(buildAgentDashboardTicketUrl('192.168.1.5', 't.k')).toBe(
      'http://192.168.1.5:4444/?ticket=t.k',
    )
  })
})
