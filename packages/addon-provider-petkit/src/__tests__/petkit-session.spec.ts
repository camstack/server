import {
  PetkitApiError,
  PetkitAuthError,
  PetkitDeviceOfflineError,
  PetkitTransportError,
} from '@apocaliss92/nodepetkit'
import {
  type Alert,
  IntegrationSessionReporter,
  type IScopedLogger,
  type SessionHealthAlertsPort,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyPetkitSessionError } from '../petkit-session.js'

function newReporter(): IntegrationSessionReporter {
  return new IntegrationSessionReporter({
    kind: 'petkit',
    providerName: 'PetKit',
    classify: classifyPetkitSessionError,
  })
}

describe('classifyPetkitSessionError', () => {
  it('an auth error is a rejected sign-in', () => {
    expect(classifyPetkitSessionError(new PetkitAuthError('login failed'))).toBe('auth-rejected')
  })

  it('PetKit session-expired code 5 is an ended session', () => {
    expect(classifyPetkitSessionError(new PetkitApiError('API error (code 5)', 5))).toBe(
      'token-expired',
    )
  })

  it('a message naming another device is a kicked session', () => {
    expect(
      classifyPetkitSessionError(
        new PetkitApiError('PetKit API error: account logged in on another device (code 125)', 125),
      ),
    ).toBe('kicked')
  })

  it('an HTTP 401 / 403 is an ended session', () => {
    expect(classifyPetkitSessionError(new PetkitApiError('HTTP GET /x returned 401'))).toBe(
      'token-expired',
    )
    expect(classifyPetkitSessionError(new PetkitApiError('HTTP GET /x returned 403'))).toBe(
      'token-expired',
    )
  })

  it('network, offline-device and unrelated API errors are NOT a session loss', () => {
    expect(classifyPetkitSessionError(new PetkitTransportError('HTTP failed'))).toBeNull()
    expect(classifyPetkitSessionError(new PetkitDeviceOfflineError('offline'))).toBeNull()
    expect(classifyPetkitSessionError(new PetkitApiError('HTTP GET /x returned 500'))).toBeNull()
    expect(classifyPetkitSessionError(new PetkitApiError('bad param (code 42)', 42))).toBeNull()
    expect(classifyPetkitSessionError(new Error('boom'))).toBeNull()
    expect(classifyPetkitSessionError('nope')).toBeNull()
  })
})

function quietLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

describe('petkit session reporting', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function make() {
    const emitted: Alert[] = []
    const updates: { alertId: string }[] = []
    const port: SessionHealthAlertsPort = {
      emit: { mutate: async (a) => void emitted.push(a) },
      update: { mutate: async (u) => void updates.push(u) },
    }
    const reporter = newReporter()
    reporter.bind({ logger: quietLogger(), getAlerts: () => port, debounceMs: 1000 })
    return { reporter, emitted, updates }
  }

  it('a kicked session raises ONE alert after the debounce, then a success resolves it', async () => {
    const { reporter, emitted, updates } = make()
    reporter.register('int-1', 'Home')
    const kicked = new PetkitApiError('logged in on another device (code 125)', 125)
    reporter.failure('int-1', kicked)
    reporter.failure('int-1', kicked)
    await vi.advanceTimersByTimeAsync(1000)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.message).toContain('Home')
    expect(emitted[0]?.metadata?.['reason']).toBe('kicked')
    await reporter.ok('int-1')
    expect(updates.at(-1)?.alertId).toBe(emitted[0]?.id)
  })

  it('a network failure never alerts', async () => {
    const { reporter, emitted } = make()
    reporter.failure('int-1', new PetkitTransportError('HTTP failed'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(emitted).toHaveLength(0)
  })

  it('does nothing (and does not throw) before it is bound', async () => {
    const reporter = newReporter()
    reporter.failure('int-1', new PetkitAuthError('x'))
    await reporter.ok('int-1')
  })
})
