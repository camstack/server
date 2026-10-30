import {
  RademacherApiError,
  RademacherAuthError,
  RademacherError,
  RademacherTransportError,
} from '@apocaliss92/noderademacher'
import { describe, expect, it, vi } from 'vitest'
import {
  buildRademacherConnectionTestProvider,
  classifyProbeFailure,
  type RademacherProbeInput,
  type RademacherProbeResult,
} from '../rademacher-connection-test.js'
import { RecordingLogger } from './recording-logger.js'

function providerWith(probe: (input: RademacherProbeInput) => Promise<RademacherProbeResult>) {
  const logger = new RecordingLogger()
  return { logger, provider: buildRademacherConnectionTestProvider({ logger, probe }) }
}

describe('Rademacher connection test', () => {
  it('validates a hub that answers, and reports model and firmware', async () => {
    const probe = vi.fn(async () => ({ model: 'HomePilot', firmware: '5.5.1' }))
    const { provider } = providerWith(probe)
    const result = await provider.testSettings({
      settings: { host: ' 192.168.10.50 ', password: 'pw', basePath: '/hp' },
    })
    expect(result.outcome).toBe('validated')
    if (result.outcome === 'validated') {
      expect(result.detail).toBe('HomePilot, firmware 5.5.1')
    }
    expect(probe).toHaveBeenCalledWith({ host: '192.168.10.50', password: 'pw', basePath: '/hp' })
  })

  it('tests an unprotected hub with no password at all', async () => {
    const probe = vi.fn(async () => ({ model: null, firmware: null }))
    const { provider } = providerWith(probe)
    const result = await provider.testSettings({ settings: { host: '10.0.0.5' } })
    expect(result.outcome).toBe('validated')
    expect(probe).toHaveBeenCalledWith({ host: '10.0.0.5', password: '', basePath: '' })
  })

  it('rejects a missing host without calling the hub', async () => {
    const probe = vi.fn(async () => ({ model: null, firmware: null }))
    const { provider } = providerWith(probe)
    for (const settings of [{}, { host: '   ' }, { host: 5 }]) {
      const result = await provider.testSettings({ settings })
      expect(result.outcome).toBe('rejected')
    }
    expect(probe).not.toHaveBeenCalled()
  })

  it('rejects a refused password, and says when none was given', async () => {
    const { provider, logger } = providerWith(async () => {
      throw new RademacherAuthError('login failed: invalid password')
    })
    const withPassword = await provider.testSettings({ settings: { host: 'h', password: 'bad' } })
    expect(withPassword).toEqual({ outcome: 'rejected', error: 'The hub refused the password.' })
    const without = await provider.testSettings({ settings: { host: 'h' } })
    expect(without.outcome).toBe('rejected')
    if (without.outcome === 'rejected') expect(without.error).toContain('password-protected')
    // A refusal is logged, never silent, and never carries the password.
    expect(logger.lines.some((l) => l.level === 'warn')).toBe(true)
    expect(JSON.stringify(logger.lines)).not.toContain('bad')
  })

  it('rejects a host that is not a HomePilot hub', async () => {
    const { provider } = providerWith(async () => {
      throw new RademacherError('no HomePilot hub responded at 10.0.0.9')
    })
    const result = await provider.testSettings({ settings: { host: '10.0.0.9' } })
    expect(result.outcome).toBe('rejected')
  })

  it('is inconclusive, never rejected, when the hub cannot be reached or fails', async () => {
    const transport = providerWith(async () => {
      throw new RademacherTransportError('fetch failed ECONNREFUSED')
    })
    const t = await transport.provider.testSettings({ settings: { host: 'h' } })
    expect(t.outcome).toBe('inconclusive')
    const api = providerWith(async () => {
      throw new RademacherApiError('HTTP 503', 503)
    })
    const a = await api.provider.testSettings({ settings: { host: 'h' } })
    expect(a.outcome).toBe('inconclusive')
    const other = providerWith(async () => {
      throw new Error('boom')
    })
    const o = await other.provider.testSettings({ settings: { host: 'h' } })
    expect(o.outcome).toBe('inconclusive')
  })

  it('classifies by error class', () => {
    expect(classifyProbeFailure(new RademacherAuthError('x')).kind).toBe('wrong-password')
    expect(classifyProbeFailure(new RademacherTransportError('x')).kind).toBe('unreachable')
    expect(classifyProbeFailure(new RademacherError('no HomePilot hub responded at h')).kind).toBe(
      'not-a-hub',
    )
    expect(classifyProbeFailure(new Error('x')).kind).toBe('other')
  })
})
