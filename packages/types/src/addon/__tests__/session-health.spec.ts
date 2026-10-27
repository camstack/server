/**
 * The standard "cloud connection lost" alert: ONE alert per integration, only
 * after a debounce, resolved by itself when the session is back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Alert } from '../../capabilities/alerts.cap.js'
import type { IScopedLogger } from '../../interfaces/logging.js'
import {
  buildSessionLostAlert,
  IntegrationSessionReporter,
  SESSION_LOST_ALERT_CATEGORY,
  type SessionHealthAlertsPort,
  SessionHealthTracker,
  sessionLostAlertId,
} from '../session-health.js'

function fakeLogger(): IScopedLogger & { readonly lines: string[] } {
  const lines: string[] = []
  const logger: IScopedLogger & { readonly lines: string[] } = {
    lines,
    debug: (m) => void lines.push(`debug:${m}`),
    info: (m) => void lines.push(`info:${m}`),
    warn: (m) => void lines.push(`warn:${m}`),
    error: (m) => void lines.push(`error:${m}`),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface UpdateCall {
  readonly alertId: string
  readonly patch: Partial<Alert>
}

function fakeAlerts(): {
  readonly port: SessionHealthAlertsPort
  readonly emitted: Alert[]
  readonly updates: UpdateCall[]
} {
  const emitted: Alert[] = []
  const updates: UpdateCall[] = []
  return {
    emitted,
    updates,
    port: {
      emit: { mutate: async (a) => void emitted.push(a) },
      update: { mutate: async (u) => void updates.push(u) },
    },
  }
}

const DEBOUNCE = 60_000

describe('SessionHealthTracker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function make(alerts: SessionHealthAlertsPort | undefined) {
    const logger = fakeLogger()
    const tracker = new SessionHealthTracker({
      kind: 'petkit',
      providerName: 'PetKit',
      logger,
      getAlerts: () => alerts,
      debounceMs: DEBOUNCE,
    })
    return { tracker, logger }
  }

  it('does not alert before the debounce elapses', async () => {
    const a = fakeAlerts()
    const { tracker } = make(a.port)
    tracker.lost('int-1', { integrationName: 'Home', reason: 'kicked' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1)
    expect(a.emitted).toHaveLength(0)
  })

  it('emits ONE alert naming the integration and the reason, with an open-integration action', async () => {
    const a = fakeAlerts()
    const { tracker } = make(a.port)
    tracker.lost('int-1', { integrationName: 'Home', reason: 'kicked' })
    tracker.lost('int-1', { integrationName: 'Home', reason: 'kicked' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    tracker.lost('int-1', { integrationName: 'Home', reason: 'kicked' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 3)
    expect(a.emitted).toHaveLength(1)
    const alert = a.emitted[0]
    expect(alert?.id).toBe(sessionLostAlertId('petkit', 'int-1'))
    expect(alert?.category).toBe(SESSION_LOST_ALERT_CATEGORY)
    expect(alert?.title).toContain('PetKit')
    expect(alert?.message).toContain('Home')
    expect(alert?.message).toContain('signed in on another device')
    expect(alert?.action).toEqual({ label: 'Open integration', href: '/integrations/int-1' })
    expect(alert?.status).toBe('active')
  })

  it('a transient loss that recovers inside the debounce never alerts', async () => {
    const a = fakeAlerts()
    const { tracker, logger } = make(a.port)
    tracker.lost('int-1', { integrationName: 'Home', reason: 'connection-lost' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE / 2)
    await tracker.restored('int-1')
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2)
    expect(a.emitted).toHaveLength(0)
    expect(a.updates).toHaveLength(0)
    expect(logger.lines.some((l) => l.includes('recovered inside the debounce'))).toBe(true)
  })

  it('resolves the alert when the session is back, once', async () => {
    const a = fakeAlerts()
    const { tracker } = make(a.port)
    tracker.lost('int-1', { integrationName: 'Home', reason: 'kicked' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    await tracker.restored('int-1')
    await tracker.restored('int-1')
    expect(a.updates).toEqual([
      {
        alertId: sessionLostAlertId('petkit', 'int-1'),
        patch: { status: 'completed', read: true },
      },
    ])
  })

  it('a new loss after a resolve starts a new alert', async () => {
    const a = fakeAlerts()
    const { tracker } = make(a.port)
    tracker.lost('int-1', { integrationName: 'Home', reason: 'kicked' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    await tracker.restored('int-1')
    tracker.lost('int-1', { integrationName: 'Home', reason: 'kicked' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(a.emitted).toHaveLength(2)
  })

  it('tracks integrations independently', async () => {
    const a = fakeAlerts()
    const { tracker } = make(a.port)
    tracker.lost('int-1', { integrationName: 'Home', reason: 'kicked' })
    tracker.lost('int-2', { integrationName: 'Office', reason: 'auth-rejected' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(a.emitted.map((x) => x.id).toSorted()).toEqual([
      sessionLostAlertId('petkit', 'int-1'),
      sessionLostAlertId('petkit', 'int-2'),
    ])
  })

  it('retries the emit on the next loss report when the emit failed', async () => {
    const a = fakeAlerts()
    let fail = true
    const port: SessionHealthAlertsPort = {
      emit: {
        mutate: async (alert) => {
          if (fail) throw new Error('boom')
          a.emitted.push(alert)
        },
      },
      update: a.port.update,
    }
    const { tracker, logger } = make(port)
    tracker.lost('int-1', { integrationName: 'Home', reason: 'kicked' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(a.emitted).toHaveLength(0)
    expect(logger.lines.some((l) => l.startsWith('warn:') && l.includes('emit failed'))).toBe(true)
    fail = false
    tracker.lost('int-1', { integrationName: 'Home', reason: 'kicked' })
    await vi.advanceTimersByTimeAsync(0)
    expect(a.emitted).toHaveLength(1)
  })

  it('logs (does not throw) when the alerts capability is missing', async () => {
    const { tracker, logger } = make(undefined)
    tracker.lost('int-1', { integrationName: 'Home', reason: 'kicked' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(logger.lines.some((l) => l.includes('alerts capability missing'))).toBe(true)
  })

  it('the first restored() of a process resolves a stale alert left by a previous run, once', async () => {
    const a = fakeAlerts()
    const { tracker } = make(a.port)
    await tracker.restored('int-1')
    await tracker.restored('int-1')
    expect(a.updates).toHaveLength(1)
  })

  it('forget() cancels a pending alert', async () => {
    const a = fakeAlerts()
    const { tracker } = make(a.port)
    tracker.lost('int-1', { integrationName: 'Home', reason: 'kicked' })
    await tracker.forget('int-1')
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2)
    expect(a.emitted).toHaveLength(0)
  })

  it('forget() resolves an active alert', async () => {
    const a = fakeAlerts()
    const { tracker } = make(a.port)
    tracker.lost('int-1', { integrationName: 'Home', reason: 'kicked' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    await tracker.forget('int-1')
    expect(a.updates).toHaveLength(1)
  })
})

describe('buildSessionLostAlert', () => {
  it('can carry a custom action (re-auth)', () => {
    const alert = buildSessionLostAlert({
      kind: 'x',
      providerName: 'X',
      integrationId: 'i',
      integrationName: 'N',
      reason: 'token-expired',
      action: { label: 'Sign in again', href: '/addon/x/start', navigation: 'server' },
      now: 5,
    })
    expect(alert.action?.label).toBe('Sign in again')
    expect(alert.createdAt).toBe(5)
    expect(alert.source).toEqual({ type: 'x', id: 'i' })
    expect(alert.metadata).toEqual({ episodeKey: 'session-lost', reason: 'token-expired' })
  })
})

describe('IntegrationSessionReporter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function make() {
    const a = fakeAlerts()
    const reporter = new IntegrationSessionReporter({
      kind: 'acme',
      providerName: 'Acme',
      classify: (err) => (err instanceof Error && err.message === 'kicked' ? 'kicked' : null),
      action: (id) => ({
        label: 'Sign in again',
        href: `/addon/acme/start?i=${id}`,
        navigation: 'server',
      }),
    })
    reporter.bind({ logger: fakeLogger(), getAlerts: () => a.port, debounceMs: 100 })
    reporter.register('i1', 'Main')
    return { reporter, a }
  }

  it('alerts only for errors the classifier calls a lost session, with the addon action', async () => {
    const { reporter, a } = make()
    reporter.failure('i1', new Error('timeout'))
    await vi.advanceTimersByTimeAsync(500)
    expect(a.emitted).toHaveLength(0)
    reporter.failure('i1', new Error('kicked'))
    await vi.advanceTimersByTimeAsync(100)
    expect(a.emitted).toHaveLength(1)
    expect(a.emitted[0]?.action?.label).toBe('Sign in again')
    expect(a.emitted[0]?.message).toContain('Main')
  })

  it('is a silent no-op before bind and after unbind', async () => {
    const reporter = new IntegrationSessionReporter({
      kind: 'acme',
      providerName: 'Acme',
      classify: () => 'kicked',
    })
    reporter.failure('i1', new Error('x'))
    await reporter.ok('i1')
    const { reporter: bound, a } = make()
    bound.unbind()
    bound.failure('i1', new Error('kicked'))
    await vi.advanceTimersByTimeAsync(500)
    expect(a.emitted).toHaveLength(0)
  })
})
